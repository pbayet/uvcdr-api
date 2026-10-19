const production = process.env.NODE_ENV === "production";

const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, !production);
    if (!production) return cb(null, true);
    return cb(null, allowedOrigins.includes(origin));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "Accept", "X-Requested-With", "X-Trace-Id"],
  exposedHeaders: ["Content-Disposition", "X-Total-Count"],
  credentials: false,
  optionsSuccessStatus: 200,
};

export default corsOptions;
