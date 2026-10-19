import express from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { authenticateToken as auth, requireAdmin } from '../middleware/auth.js';
import { RedeemItem, RedeemOrder } from '../models/Redeem.js';
import User from '../models/User.js';

const router = express.Router();

const CATEGORIES = ['electronics', 'clothing', 'books', 'accessories', 'vouchers'];
const ORDER_STATUSES = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
const MAX_QUANTITY = 10; // same limit as the quantity box in the Store
const STORE_IMAGE_FOLDER = 'codethrone/store';

const isValidId = (id) => mongoose.isValidObjectId(id);

/* ------------------------------------------------------------------ */
/* Cloudinary (image upload for products)                              */
/* ------------------------------------------------------------------ */

const cloudinaryConfigured = () =>
  !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

const configureCloudinary = () =>
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

// Best effort: a failed image delete must never block saving/deleting a product.
// Only images we uploaded for the store are ever deleted (never document images etc.).
async function destroyStoreImage(publicId) {
  if (!publicId || !publicId.startsWith(`${STORE_IMAGE_FOLDER}/`) || !cloudinaryConfigured()) return;
  try {
    configureCloudinary();
    await cloudinary.uploader.destroy(publicId);
  } catch (error) {
    console.error('⚠️ Could not delete store image from Cloudinary:', error.message);
  }
}

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 1 }, // 3 MB
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('INVALID_TYPE'));
  },
});

// Turns multer errors into normal JSON responses instead of an HTML error page.
const receiveImage = (req, res, next) => {
  imageUpload.single('image')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Image must be smaller than 3 MB' });
    if (err.message === 'INVALID_TYPE') return res.status(400).json({ error: 'Only JPG, PNG, WEBP or GIF images are allowed' });
    return res.status(400).json({ error: 'Could not read the uploaded image' });
  });
};

/* ------------------------------------------------------------------ */
/* Input validation for products                                       */
/* ------------------------------------------------------------------ */

// Returns { data } with only whitelisted, validated fields, or { error }.
// partial = true (update): only the fields that were sent are checked.
function parseItemInput(body, { partial = false } = {}) {
  const data = {};
  const has = (key) => body[key] !== undefined;
  const need = (key, label) => (!partial && !has(key) ? `${label} is required` : null);

  const intIn = (key, label, min, max) => {
    const n = Number(body[key]);
    if (body[key] === '' || body[key] === null || !Number.isInteger(n) || n < min || n > max) {
      return `${label} must be a whole number between ${min} and ${max}`;
    }
    data[key] = n;
    return null;
  };

  const checks = [
    () => need('name', 'Name'),
    () => {
      if (!has('name')) return null;
      const v = String(body.name).trim();
      if (!v || v.length > 100) return 'Name is required (max 100 characters)';
      data.name = v;
      return null;
    },
    () => need('description', 'Description'),
    () => {
      if (!has('description')) return null;
      const v = String(body.description).trim();
      if (!v || v.length > 1000) return 'Description is required (max 1000 characters)';
      data.description = v;
      return null;
    },
    () => need('coinsCost', 'Coin price'),
    () => (has('coinsCost') ? intIn('coinsCost', 'Coin price', 1, 1000000) : null),
    () => need('category', 'Category'),
    () => {
      if (!has('category')) return null;
      if (!CATEGORIES.includes(body.category)) return `Category must be one of: ${CATEGORIES.join(', ')}`;
      data.category = body.category;
      return null;
    },
    () => need('stock', 'Stock'),
    () => {
      if (!has('stock')) return null;
      const err = intIn('stock', 'Stock', 0, 100000);
      if (!err) data.inStock = data.stock > 0; // keep the flag the Store reads in sync
      return err;
    },
    () => need('imageUrl', 'Product image'),
    () => {
      if (!has('imageUrl')) return null;
      const v = String(body.imageUrl).trim();
      if (!/^https:\/\/\S+$/i.test(v) || v.length > 500) return 'Product image must be a valid https URL';
      data.imageUrl = v;
      return null;
    },
    () => {
      if (!has('imagePublicId')) return null;
      data.imagePublicId = body.imagePublicId ? String(body.imagePublicId).slice(0, 200) : undefined;
      return null;
    },
    () => {
      if (!has('isActive')) return null;
      if (typeof body.isActive !== 'boolean') return 'isActive must be true or false';
      data.isActive = body.isActive;
      return null;
    },
    () => (has('popularity') ? intIn('popularity', 'Popularity', 0, 100) : null),
  ];

  for (const check of checks) {
    const error = check();
    if (error) return { error };
  }
  return { data };
}

/* ------------------------------------------------------------------ */
/* User: browse the Store                                              */
/* ------------------------------------------------------------------ */

// Items shown in the user Store (hidden products are excluded)
const visibleItems = { isActive: { $ne: false } };

router.get('/items', auth, async (req, res) => {
  try {
    const items = await RedeemItem.find(visibleItems).sort({ popularity: -1, createdAt: -1 });
    res.json({ items });
  } catch (error) {
    console.error('Error fetching redeem items:', error);
    res.status(500).json({ error: 'Failed to fetch redeem items' });
  }
});

router.get('/items/:category', auth, async (req, res) => {
  try {
    const { category } = req.params;
    const items = await RedeemItem.find({ ...visibleItems, category }).sort({ popularity: -1, createdAt: -1 });
    res.json({ items });
  } catch (error) {
    console.error('Error fetching redeem items by category:', error);
    res.status(500).json({ error: 'Failed to fetch redeem items' });
  }
});

/* ------------------------------------------------------------------ */
/* User: redeem (order)                                                */
/* ------------------------------------------------------------------ */

const ADDRESS_FIELDS = ['fullName', 'phone', 'address', 'city', 'state', 'pincode'];

router.post('/order', auth, async (req, res) => {
  const userId = req.user._id;
  let qty = 1;
  let item = null;
  let totalCost = 0;
  let stockReserved = false;
  let coinsDeducted = false;

  try {
    const { itemId, deliveryAddress } = req.body;
    qty = Number(req.body.quantity ?? 1);

    if (!itemId || !deliveryAddress || typeof deliveryAddress !== 'object') {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!isValidId(itemId)) {
      return res.status(400).json({ error: 'Invalid item' });
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) {
      return res.status(400).json({ error: `Quantity must be a whole number between 1 and ${MAX_QUANTITY}` });
    }

    // Validate delivery address fields
    const address = {};
    for (const field of ADDRESS_FIELDS) {
      const value = deliveryAddress[field];
      if (typeof value !== 'string' || value.trim() === '') {
        return res.status(400).json({ error: `Missing or empty field: ${field}` });
      }
      address[field] = value.trim().slice(0, 300);
    }

    item = await RedeemItem.findById(itemId);
    if (!item || item.isActive === false) {
      return res.status(404).json({ error: 'Item not found' });
    }
    if (!item.inStock) {
      return res.status(400).json({ error: 'Item is out of stock' });
    }

    totalCost = item.coinsCost * qty;

    // 1) Reserve stock atomically (only for items that track stock)
    if (typeof item.stock === 'number') {
      const reserved = await RedeemItem.findOneAndUpdate(
        { _id: item._id, isActive: { $ne: false }, stock: { $gte: qty } },
        { $inc: { stock: -qty } },
        { new: true }
      );
      if (!reserved) {
        const fresh = await RedeemItem.findById(item._id);
        const left = fresh?.stock ?? 0;
        return res.status(400).json({
          error: left > 0 ? `Only ${left} left in stock` : 'Item is out of stock',
        });
      }
      stockReserved = true;
      if (reserved.stock <= 0) {
        await RedeemItem.updateOne({ _id: item._id, stock: { $lte: 0 } }, { $set: { inStock: false } });
      }
    }

    // 2) Take the coins atomically: succeeds only if the user still has enough
    const paidUser = await User.findOneAndUpdate(
      { _id: userId, coins: { $gte: totalCost } },
      { $inc: { coins: -totalCost } },
      { new: true }
    );
    if (!paidUser) {
      if (stockReserved) {
        await RedeemItem.updateOne({ _id: item._id }, { $inc: { stock: qty }, $set: { inStock: true } });
        stockReserved = false;
      }
      const current = await User.findById(userId).select('coins');
      return res.status(400).json({
        error: `Insufficient coins. You need ${totalCost} coins but have ${current?.coins || 0} coins.`,
      });
    }
    coinsDeducted = true;

    // 3) Create the order
    const order = new RedeemOrder({
      userId,
      itemId: item._id,
      quantity: qty,
      totalCost,
      itemName: item.name,
      itemImageUrl: item.imageUrl,
      unitCost: item.coinsCost,
      deliveryAddress: address,
    });
    await order.save();
    await order.populate('itemId', 'name description imageUrl');

    res.status(201).json({
      message: 'Order placed successfully',
      order,
      remainingCoins: paidUser.coins,
    });
  } catch (error) {
    console.error('Error creating redeem order:', error);
    // Undo whatever already happened so nobody loses coins or stock for a failed order
    try {
      if (coinsDeducted) await User.updateOne({ _id: userId }, { $inc: { coins: totalCost } });
      if (stockReserved) {
        await RedeemItem.updateOne({ _id: item._id }, { $inc: { stock: qty }, $set: { inStock: true } });
      }
    } catch (rollbackError) {
      console.error('❌ Rollback failed after order error:', rollbackError.message);
    }
    res.status(500).json({ error: 'Failed to process order' });
  }
});

// If the product was deleted later, fall back to the copy saved with the order
const withItemFallback = (order) => {
  const o = order.toObject ? order.toObject() : order;
  if (!o.itemId && o.itemName) {
    o.itemId = { _id: null, name: o.itemName, imageUrl: o.itemImageUrl, coinsCost: o.unitCost };
  }
  return o;
};

router.get('/orders', auth, async (req, res) => {
  try {
    const orders = await RedeemOrder.find({ userId: req.user._id })
      .populate('itemId', 'name description imageUrl coinsCost')
      .sort({ orderDate: -1 });

    res.json({ orders: orders.map(withItemFallback) });
  } catch (error) {
    console.error('Error fetching user orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

router.get('/orders/:orderId', auth, async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!isValidId(orderId)) return res.status(404).json({ error: 'Order not found' });

    const order = await RedeemOrder.findOne({ _id: orderId, userId: req.user._id })
      .populate('itemId', 'name description imageUrl coinsCost');

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ order: withItemFallback(order) });
  } catch (error) {
    console.error('Error fetching order details:', error);
    res.status(500).json({ error: 'Failed to fetch order details' });
  }
});

/* ------------------------------------------------------------------ */
/* Admin: store product management  (all routes: login + admin role)   */
/* ------------------------------------------------------------------ */

// List every product, including hidden and out-of-stock ones
router.get('/admin/items', auth, requireAdmin, async (req, res) => {
  try {
    const items = await RedeemItem.find().sort({ createdAt: -1 });
    res.json({ items });
  } catch (error) {
    console.error('Error fetching admin redeem items:', error);
    res.status(500).json({ error: 'Failed to fetch items' });
  }
});

// Upload a product image to Cloudinary
router.post('/admin/upload-image', auth, requireAdmin, receiveImage, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }
    if (!cloudinaryConfigured()) {
      return res.status(503).json({
        error: 'Image upload is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in .env',
      });
    }
    configureCloudinary();

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: STORE_IMAGE_FOLDER,
          resource_type: 'image',
          transformation: [{ width: 800, height: 800, crop: 'limit' }, { quality: 'auto' }, { fetch_format: 'auto' }],
        },
        (error, uploaded) => (error ? reject(error) : resolve(uploaded))
      );
      stream.end(req.file.buffer);
    });

    res.json({ success: true, url: result.secure_url, publicId: result.public_id });
  } catch (error) {
    console.error('❌ Store image upload failed:', error.message);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// Remove an image that was uploaded but never saved with a product (e.g. the admin cancelled the form).
// Refuses images that belong to a product and anything outside the store folder.
router.delete('/admin/upload-image', auth, requireAdmin, async (req, res) => {
  try {
    const { publicId } = req.body || {};
    if (typeof publicId !== 'string' || !publicId.startsWith(`${STORE_IMAGE_FOLDER}/`)) {
      return res.status(400).json({ error: 'Invalid image id' });
    }
    if (await RedeemItem.exists({ imagePublicId: publicId })) {
      return res.status(409).json({ error: 'This image is used by a product' });
    }
    await destroyStoreImage(publicId);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Store image delete failed:', error.message);
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

// Add product
router.post('/admin/items', auth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = parseItemInput(req.body || {});
    if (error) return res.status(400).json({ error });

    const item = new RedeemItem(data);
    await item.save();
    res.status(201).json({ message: 'Item added successfully', item });
  } catch (error) {
    console.error('Error adding redeem item:', error);
    res.status(500).json({ error: 'Failed to add item' });
  }
});

// Edit product (also used to hide/show a product and to change stock)
router.put('/admin/items/:itemId', auth, requireAdmin, async (req, res) => {
  try {
    const { itemId } = req.params;
    if (!isValidId(itemId)) return res.status(400).json({ error: 'Invalid item id' });

    const { data, error } = parseItemInput(req.body || {}, { partial: true });
    if (error) return res.status(400).json({ error });
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'Nothing to update' });

    const before = await RedeemItem.findById(itemId);
    if (!before) return res.status(404).json({ error: 'Item not found' });

    const item = await RedeemItem.findByIdAndUpdate(itemId, { $set: data }, { new: true, runValidators: true });

    // The image was replaced: remove the old one from Cloudinary
    if (before.imagePublicId && before.imagePublicId !== item.imagePublicId) {
      await destroyStoreImage(before.imagePublicId);
    }

    res.json({ message: 'Item updated successfully', item });
  } catch (error) {
    console.error('Error updating redeem item:', error);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// Delete product (past orders keep their own copy of name/image/price)
router.delete('/admin/items/:itemId', auth, requireAdmin, async (req, res) => {
  try {
    const { itemId } = req.params;
    if (!isValidId(itemId)) return res.status(400).json({ error: 'Invalid item id' });

    const item = await RedeemItem.findByIdAndDelete(itemId);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    await destroyStoreImage(item.imagePublicId);
    res.json({ message: 'Item deleted successfully' });
  } catch (error) {
    console.error('Error deleting redeem item:', error);
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

/* ------------------------------------------------------------------ */
/* Admin: orders                                                       */
/* ------------------------------------------------------------------ */

router.get('/admin/orders', auth, requireAdmin, async (req, res) => {
  try {
    const orders = await RedeemOrder.find()
      .populate('userId', 'username email profile')
      .populate('itemId', 'name description imageUrl coinsCost')
      .sort({ orderDate: -1 });

    res.json({ orders: orders.map(withItemFallback) });
  } catch (error) {
    console.error('Error fetching all orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

router.put('/admin/orders/:orderId', auth, requireAdmin, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status, trackingNumber } = req.body;

    if (!isValidId(orderId)) return res.status(404).json({ error: 'Order not found' });
    if (!ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${ORDER_STATUSES.join(', ')}` });
    }

    const updateData = { status };
    if (trackingNumber) {
      updateData.trackingNumber = String(trackingNumber).slice(0, 100);
    }

    const order = await RedeemOrder.findByIdAndUpdate(
      orderId,
      updateData,
      { new: true, runValidators: true }
    ).populate('userId', 'username email').populate('itemId', 'name');

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ message: 'Order updated successfully', order });
  } catch (error) {
    console.error('Error updating order:', error);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

export default router;
