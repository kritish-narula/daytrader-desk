if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !window.Capacitor) navigator.serviceWorker.register('sw.js');
