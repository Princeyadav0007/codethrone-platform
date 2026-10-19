// API Configuration
const PRODUCTION_API_URL = 'https://codestar-fullstack-y54l.onrender.com/api';
const PRODUCTION_SOCKET_URL = 'https://codestar-fullstack-y54l.onrender.com';

export const API_CONFIG = {
BASE_URL:
import.meta.env.VITE_API_URL ||
(import.meta.env.MODE === 'development'
? 'http://localhost:5000/api'
: PRODUCTION_API_URL),

SOCKET_URL:
import.meta.env.VITE_SOCKET_URL ||
(import.meta.env.MODE === 'development'
? 'http://localhost:5000'
: PRODUCTION_SOCKET_URL),
};

// Helper function to get full API URL
export const getApiUrl = (endpoint: string) => {
const cleanEndpoint = endpoint.startsWith('/')
? endpoint.slice(1)
: endpoint;

return `${API_CONFIG.BASE_URL}/${cleanEndpoint}`;
};

// Helper function to get Socket.IO URL
export const getSocketUrl = () => API_CONFIG.SOCKET_URL;

// Export individual URLs for easy access
export const API_BASE_URL = API_CONFIG.BASE_URL.replace(/\/api\/?$/, '');
export const API_URL = API_CONFIG.BASE_URL;
export const SOCKET_URL = API_CONFIG.SOCKET_URL;
