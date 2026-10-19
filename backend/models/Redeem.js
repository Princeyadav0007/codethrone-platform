import mongoose from 'mongoose';

const redeemItemSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true
  },
  coinsCost: {
    type: Number,
    required: true,
    min: 1,
    validate: { validator: Number.isInteger, message: 'coinsCost must be a whole number' }
  },
  category: {
    type: String,
    required: true,
    enum: ['electronics', 'clothing', 'books', 'accessories', 'vouchers']
  },
  imageUrl: {
    type: String,
    required: true
  },
  // Cloudinary public id of the uploaded image (used to delete the old image when it is replaced/removed)
  imagePublicId: {
    type: String
  },
  // Units left. Items created before this field existed have no value here = stock is not tracked
  // for them (they only use the inStock flag). Items created from the Admin panel always have it.
  stock: {
    type: Number,
    min: 0,
    validate: { validator: Number.isInteger, message: 'stock must be a whole number' }
  },
  // Kept in sync with stock by the API (stock > 0). The user Store reads this flag.
  inStock: {
    type: Boolean,
    default: true
  },
  // Admin can hide a product from the user Store without deleting it
  isActive: {
    type: Boolean,
    default: true
  },
  popularity: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const redeemOrderSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  itemId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RedeemItem',
    required: true
  },
  quantity: {
    type: Number,
    required: true,
    min: 1,
    default: 1
  },
  totalCost: {
    type: Number,
    required: true,
    min: 1
  },
  // Copy of the product at order time (order history must still make sense if the product is edited/deleted)
  itemName: { type: String },
  itemImageUrl: { type: String },
  unitCost: { type: Number },
  deliveryAddress: {
    fullName: {
      type: String,
      required: true,
      trim: true
    },
    phone: {
      type: String,
      required: true,
      trim: true
    },
    address: {
      type: String,
      required: true,
      trim: true
    },
    city: {
      type: String,
      required: true,
      trim: true
    },
    state: {
      type: String,
      required: true,
      trim: true
    },
    pincode: {
      type: String,
      required: true,
      trim: true
    }
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
    default: 'pending'
  },
  orderDate: {
    type: Date,
    default: Date.now
  },
  trackingNumber: {
    type: String,
    sparse: true
  }
});

const RedeemItem = mongoose.model('RedeemItem', redeemItemSchema);
const RedeemOrder = mongoose.model('RedeemOrder', redeemOrderSchema);

export { RedeemItem, RedeemOrder };
