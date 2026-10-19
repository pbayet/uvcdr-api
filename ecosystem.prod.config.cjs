module.exports = {
  apps: [
    {
      name: "UVCDR API PROD",
      script: "app.js",
      cwd: "./",
      instances: 1,
      exec_mode: "fork",
      watch: true,
      ignore_watch: [
        "assets",
        "node_modules",
        "logs",
        "uploads",
        "temp",
        "tmp",
        "api.http",
      ],
      env: {
        NODE_ENV: "production",
        PORT: 3001,
        API_BASE_ROUTE: "api",
      },
      log_date_format: "", // OK
      time: false, // pas de timestamp PM2
      // log_type: "raw",  // au besoin, pour éviter tout formatage
    },
  ],
};
