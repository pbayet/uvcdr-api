// Serveur de test (VM-DEV) : même fonctionnement que la prod (redémarrage par
// restart.trigger, cf. npm run deploy:test), avec la configuration de dev.
module.exports = {
  apps: [
    {
      name: "UVCDR API TEST",
      script: "app.js",
      cwd: "./",
      instances: 1,
      exec_mode: "fork",
      // Seul ce fichier est surveillé : le déploiement automatique (runner GitHub)
      // le réécrit après git pull + npm install pour faire redémarrer l'API.
      // Ne jamais remettre watch: true (PM2 redémarrerait en plein git pull).
      watch: ["restart.trigger"],
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
        NODE_ENV: "development",
        PORT: 3001,
        API_BASE_ROUTE: "api",
      },
      log_date_format: "", // OK
      time: false, // pas de timestamp PM2
      // log_type: "raw",  // au besoin, pour éviter tout formatage
    },
  ],
};
