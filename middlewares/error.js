// middlewares/error.js
export function notFound(_req, res) {
  res.status(404).json({ error: "Not Found" });
}
export function errorHandler(err, _req, res, _next) {
  const status = err.status || 500;
  const isProd = (process.env.NODE_ENV || "development") === "production";
  if (!isProd) console.error(err);
  res.status(status).json({ error: isProd ? "Internal Server Error" : err.message || "Internal Error" });
}
