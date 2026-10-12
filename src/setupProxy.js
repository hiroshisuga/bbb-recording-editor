const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function (app) {
    if (process.env.BBB_EDITOR_PROXY) {
        const prefix = process.env.REACT_APP_EDITOR_PREFIX || '/recording-editor';
        app.use(`${prefix}/api`, createProxyMiddleware({
            target: process.env.BBB_EDITOR_PROXY, changeOrigin: false,
        }));
    }
};
