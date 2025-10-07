export function notFound(_req, res) {
  res.status(404).json({ error: "Not Found" });
}
export function errorHandler(err, _req, res, _next) {
  console.error(err);
  res.status(500).json({ error: err.message || "Server Error" });
}
