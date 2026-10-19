import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { API_URL } from '../../config/api';
import { useAuth } from '../../contexts/AuthContext';
import {
  Plus,
  Edit,
  Trash2,
  Save,
  X,
  Eye,
  EyeOff,
  Upload,
  Coins,
  ShoppingCart,
  Loader2,
} from 'lucide-react';

// Same shape the backend (RedeemItem model) uses
interface StoreItem {
  _id: string;
  name: string;
  description: string;
  coinsCost: number;
  category: string;
  imageUrl: string;
  imagePublicId?: string;
  stock?: number; // missing on products created before stock tracking existed
  inStock: boolean;
  isActive?: boolean;
  popularity: number;
  createdAt: string;
}

interface FormState {
  name: string;
  description: string;
  coinsCost: string;
  category: string;
  stock: string;
  popularity: string;
  imageUrl: string;
  imagePublicId: string;
  isActive: boolean;
}

const CATEGORIES = [
  { id: 'electronics', label: 'Electronics' },
  { id: 'clothing', label: 'Clothing' },
  { id: 'books', label: 'Books' },
  { id: 'accessories', label: 'Accessories' },
  { id: 'vouchers', label: 'Vouchers' },
];

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const LOW_STOCK_LIMIT = 5;

const emptyForm: FormState = {
  name: '',
  description: '',
  coinsCost: '',
  category: 'accessories',
  stock: '',
  popularity: '0',
  imageUrl: '',
  imagePublicId: '',
  isActive: true,
};

const inputClass =
  'w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-800 dark:text-white';

const StoreManagementTab: React.FC = () => {
  const { token } = useAuth();
  const authHeaders = () => ({ Authorization: `Bearer ${token || localStorage.getItem('token')}` });

  const [items, setItems] = useState<StoreItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Image uploaded in the open form but not saved yet (deleted again if the form is cancelled/replaced)
  const unsavedUploadRef = useRef<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const errorText = (err: any, fallback: string) =>
    err?.response?.data?.error || err?.response?.data?.message || fallback;

  const notify = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    window.setTimeout(() => setMessage(null), 4500);
  };

  const loadItems = async () => {
    try {
      setLoadError('');
      const res = await axios.get(`${API_URL}/redeem/admin/items`, { headers: authHeaders() });
      setItems(res.data.items || []);
    } catch (err) {
      setLoadError(errorText(err, 'Failed to load store products'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- image handling ---------------- */

  const discardUnsavedUpload = async () => {
    const publicId = unsavedUploadRef.current;
    unsavedUploadRef.current = '';
    if (!publicId) return;
    try {
      await axios.delete(`${API_URL}/redeem/admin/upload-image`, { headers: authHeaders(), data: { publicId } });
    } catch {
      /* orphan clean-up is best effort */
    }
  };

  const handleImageChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow choosing the same file again
    if (!file) return;

    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
      notify('error', 'Only JPG, PNG, WEBP or GIF images are allowed');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      notify('error', 'Image must be smaller than 3 MB');
      return;
    }

    setUploading(true);
    try {
      const body = new FormData();
      body.append('image', file);
      const res = await axios.post(`${API_URL}/redeem/admin/upload-image`, body, { headers: authHeaders() });

      await discardUnsavedUpload(); // the previous unsaved upload is no longer needed
      unsavedUploadRef.current = res.data.publicId;
      setForm((prev) => ({ ...prev, imageUrl: res.data.url, imagePublicId: res.data.publicId }));
    } catch (err) {
      notify('error', errorText(err, 'Image upload failed'));
    } finally {
      setUploading(false);
    }
  };

  /* ---------------- form open / close ---------------- */

  const openAdd = () => {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(true);
  };

  const openEdit = (item: StoreItem) => {
    setEditingId(item._id);
    setForm({
      name: item.name,
      description: item.description,
      coinsCost: String(item.coinsCost),
      category: item.category,
      stock: item.stock === undefined ? '' : String(item.stock),
      popularity: String(item.popularity ?? 0),
      imageUrl: item.imageUrl,
      imagePublicId: item.imagePublicId || '',
      isActive: item.isActive !== false,
    });
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const closeForm = async () => {
    await discardUnsavedUpload();
    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm);
  };

  /* ---------------- save / delete / toggle ---------------- */

  const validate = (): string | null => {
    if (!form.name.trim()) return 'Product name is required';
    if (!form.description.trim()) return 'Description is required';
    const cost = Number(form.coinsCost);
    if (form.coinsCost === '' || !Number.isInteger(cost) || cost < 1) return 'Coin price must be a whole number of at least 1';
    const stock = Number(form.stock);
    if (form.stock === '' || !Number.isInteger(stock) || stock < 0) return 'Stock must be a whole number (0 or more)';
    const pop = Number(form.popularity);
    if (form.popularity === '' || !Number.isInteger(pop) || pop < 0 || pop > 100) return 'Popularity must be between 0 and 100';
    if (!form.imageUrl) return 'Please upload a product image';
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = validate();
    if (problem) {
      notify('error', problem);
      return;
    }

    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      description: form.description.trim(),
      coinsCost: Number(form.coinsCost),
      category: form.category,
      stock: Number(form.stock),
      popularity: Number(form.popularity),
      imageUrl: form.imageUrl,
      isActive: form.isActive,
    };
    if (form.imagePublicId) payload.imagePublicId = form.imagePublicId;

    setSaving(true);
    try {
      if (editingId) {
        await axios.put(`${API_URL}/redeem/admin/items/${editingId}`, payload, { headers: authHeaders() });
      } else {
        await axios.post(`${API_URL}/redeem/admin/items`, payload, { headers: authHeaders() });
      }
      unsavedUploadRef.current = ''; // the uploaded image now belongs to the product
      notify('success', editingId ? 'Product updated. Changes are live in the Store.' : 'Product added. It is now live in the Store.');
      setShowForm(false);
      setEditingId(null);
      setForm(emptyForm);
      await loadItems();
    } catch (err) {
      notify('error', errorText(err, 'Failed to save product'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (item: StoreItem) => {
    if (!window.confirm(`Delete "${item.name}" from the Store? Past orders will keep their record.`)) return;
    setBusyId(item._id);
    try {
      await axios.delete(`${API_URL}/redeem/admin/items/${item._id}`, { headers: authHeaders() });
      setItems((prev) => prev.filter((i) => i._id !== item._id));
      notify('success', 'Product deleted');
    } catch (err) {
      notify('error', errorText(err, 'Failed to delete product'));
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleVisible = async (item: StoreItem) => {
    setBusyId(item._id);
    try {
      const res = await axios.put(
        `${API_URL}/redeem/admin/items/${item._id}`,
        { isActive: item.isActive === false },
        { headers: authHeaders() }
      );
      setItems((prev) => prev.map((i) => (i._id === item._id ? res.data.item : i)));
      notify('success', item.isActive === false ? 'Product is now visible in the Store' : 'Product hidden from the Store');
    } catch (err) {
      notify('error', errorText(err, 'Failed to update product'));
    } finally {
      setBusyId(null);
    }
  };

  /* ---------------- derived data ---------------- */

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(
      (i) =>
        (categoryFilter === 'all' || i.category === categoryFilter) &&
        (!q || i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q))
    );
  }, [items, search, categoryFilter]);

  const visibleCount = items.filter((i) => i.isActive !== false).length;
  const outOfStockCount = items.filter((i) => !i.inStock).length;

  const stockCell = (item: StoreItem) => {
    if (item.stock === undefined) {
      return <span className="text-amber-600 text-sm" title="Edit the product to set a stock number">Not set</span>;
    }
    if (item.stock === 0) return <span className="text-red-600 font-medium">0 (out of stock)</span>;
    if (item.stock <= LOW_STOCK_LIMIT) return <span className="text-amber-600 font-medium">{item.stock} (low)</span>;
    return <span>{item.stock}</span>;
  };

  /* ---------------- render ---------------- */

  return (
    <div className="space-y-6">
      {message && (
        <div
          className={`p-4 rounded-lg border ${
            message.type === 'success'
              ? 'bg-green-50 border-green-200 text-green-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-xl font-semibold flex items-center">
            <ShoppingCart className="h-5 w-5 mr-2" />
            Store Management
          </h3>
          <p className="text-sm text-gray-500 mt-1">
            {items.length} products · {visibleCount} visible · {outOfStockCount} out of stock. Changes appear in the user Store instantly.
          </p>
        </div>
        {!showForm && (
          <button
            onClick={openAdd}
            className="flex items-center px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors font-medium"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Product
          </button>
        )}
      </div>

      {/* Add / Edit form */}
      {showForm && (
        <div className="bg-gray-50 dark:bg-gray-800 p-6 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between mb-4">
            <h4 className="text-lg font-semibold">{editingId ? 'Edit Product' : 'Add New Product'}</h4>
            <button
              type="button"
              onClick={closeForm}
              className="p-2 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full transition-colors"
              aria-label="Close form"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="bg-white dark:bg-gray-900 p-4 rounded-lg border">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">Product Name *</label>
                  <input
                    type="text"
                    maxLength={100}
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className={inputClass}
                    placeholder="e.g., Coding T-Shirt"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">Category *</label>
                  <select
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    className={inputClass}
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c.id} value={c.id}>{c.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">Coin Price *</label>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={form.coinsCost}
                    onChange={(e) => setForm({ ...form, coinsCost: e.target.value })}
                    className={inputClass}
                    placeholder="e.g., 500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">Stock *</label>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={form.stock}
                    onChange={(e) => setForm({ ...form, stock: e.target.value })}
                    className={inputClass}
                    placeholder="Units available (0 = out of stock)"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">Popularity (0-100)</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={form.popularity}
                    onChange={(e) => setForm({ ...form, popularity: e.target.value })}
                    className={inputClass}
                  />
                  <p className="text-xs text-gray-500 mt-1">Higher numbers are listed first in the Store.</p>
                </div>
                <div className="flex items-center">
                  <label className="flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.isActive}
                      onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                      className="h-4 w-4 mr-2"
                    />
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Visible in the Store</span>
                  </label>
                </div>
              </div>

              <div className="mt-4">
                <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">Description *</label>
                <textarea
                  rows={3}
                  maxLength={1000}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className={inputClass}
                  placeholder="Short description shown on the product card"
                />
              </div>
            </div>

            <div className="bg-white dark:bg-gray-900 p-4 rounded-lg border">
              <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">Product Image *</label>
              <div className="flex flex-wrap items-center gap-4">
                <div className="h-28 w-28 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 flex items-center justify-center overflow-hidden bg-gray-50 dark:bg-gray-800">
                  {uploading ? (
                    <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
                  ) : form.imageUrl ? (
                    <img src={form.imageUrl} alt="Product preview" className="h-full w-full object-cover" />
                  ) : (
                    <Upload className="h-6 w-6 text-gray-400" />
                  )}
                </div>
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    onChange={handleImageChosen}
                    className="hidden"
                  />
                  <button
                    type="button"
                    disabled={uploading}
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded-lg transition-colors font-medium disabled:opacity-60"
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    {uploading ? 'Uploading...' : form.imageUrl ? 'Replace Image' : 'Upload Image'}
                  </button>
                  <p className="text-xs text-gray-500 mt-2">JPG, PNG, WEBP or GIF, up to 3 MB. Stored on Cloudinary.</p>
                </div>
              </div>
            </div>

            <div className="flex space-x-4 pt-2">
              <button
                type="submit"
                disabled={saving || uploading}
                className="flex items-center px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors font-medium disabled:opacity-60"
              >
                {saving ? <Loader2 className="h-5 w-5 mr-2 animate-spin" /> : <Save className="h-5 w-5 mr-2" />}
                {editingId ? 'Update Product' : 'Add Product'}
              </button>
              <button
                type="button"
                onClick={closeForm}
                className="flex items-center px-6 py-3 bg-gray-500 hover:bg-gray-600 text-white rounded-lg transition-colors font-medium"
              >
                <X className="h-5 w-5 mr-2" />
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search products..."
          className="flex-1 min-w-[200px] px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-800 dark:text-white"
        />
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 dark:bg-gray-800 dark:text-white"
        >
          <option value="all">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
      </div>

      {/* Product list */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
        </div>
      ) : loadError ? (
        <div className="text-center py-10 border border-red-200 rounded-lg bg-red-50 text-red-800">
          <p className="mb-3">{loadError}</p>
          <button onClick={() => { setLoading(true); loadItems(); }} className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg">
            Try again
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <ShoppingCart className="h-10 w-10 mx-auto mb-3 opacity-50" />
          {items.length === 0 ? 'No products yet. Click "Add Product" to create the first one.' : 'No products match your search.'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Product</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Category</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Price</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Stock</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {filtered.map((item) => (
                <tr key={item._id} className={item.isActive === false ? 'opacity-60' : ''}>
                  <td className="px-4 py-3">
                    <div className="flex items-center">
                      <img
                        src={item.imageUrl}
                        alt={item.name}
                        className="h-12 w-12 rounded-md object-cover mr-3 bg-gray-100"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
                      />
                      <div className="min-w-0">
                        <p className="font-medium truncate max-w-[260px]">{item.name}</p>
                        <p className="text-xs text-gray-500 truncate max-w-[260px]">{item.description}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm capitalize">{item.category}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className="inline-flex items-center font-medium">
                      <Coins className="h-4 w-4 text-yellow-500 mr-1" />
                      {item.coinsCost}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm whitespace-nowrap">{stockCell(item)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span
                      className={`px-2 py-1 rounded-full text-xs font-medium ${
                        item.isActive === false
                          ? 'bg-gray-100 text-gray-700'
                          : item.inStock
                          ? 'bg-green-100 text-green-800'
                          : 'bg-red-100 text-red-800'
                      }`}
                    >
                      {item.isActive === false ? 'Hidden' : item.inStock ? 'Live' : 'Out of stock'}
                    </span>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <div className="flex items-center space-x-1">
                      <button
                        onClick={() => openEdit(item)}
                        disabled={busyId === item._id}
                        className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                        title="Edit"
                      >
                        <Edit className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleToggleVisible(item)}
                        disabled={busyId === item._id}
                        className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                        title={item.isActive === false ? 'Show in Store' : 'Hide from Store'}
                      >
                        {item.isActive === false ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                      </button>
                      <button
                        onClick={() => handleDelete(item)}
                        disabled={busyId === item._id}
                        className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default StoreManagementTab;
