const path = require('path');

module.exports = {
    mode: 'development',
    entry: {
        app: './src/index.js',
    },
    devtool: 'inline-source-map',
    devServer: {
        static: './dist',
        liveReload: false,
    },
    output: {
        filename: 'bundle.js',
        path: path.resolve(__dirname, 'dist'),
    },
};
