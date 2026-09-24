import express from "express";
import { trialsRouter } from "./routes/trials.js";

const app = express();
app.use(express.json());

app.use("/trials", trialsRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

export { app };
