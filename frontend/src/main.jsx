import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

// Set API URL from env (Vite injects this at build time)
if (import.meta.env.VITE_API_URL) {
  window.__FRESCLAW_API_URL = import.meta.env.VITE_API_URL + '/api/v1';
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
