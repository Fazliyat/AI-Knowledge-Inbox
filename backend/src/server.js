import itemRoutes from "./routes/itemRoutes.js";
import chatRoutes from "./routes/chatRoutes.js";
import draftRoutes from "./routes/draftRoutes.js";
import searchRoutes from "./routes/searchRoutes.js";
import documentRoutes from "./routes/documentRoutes.js";
import { indexAllUnindexedItems } from "./services/retrievalService.js";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import pino from "pino";
import pinoHttp from "pino-http";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

const backendEnv = dotenv.config({
  path: fileURLToPath(new URL("../.env", import.meta.url)),
  override: true,
});
process.env.GEMINI_API_KEY = backendEnv.parsed?.GEMINI_API_KEY?.trim() ||
  process.env.GEMINI_API_KEY?.trim() || "";

const app = express();
const logger = pino();

const PORT = process.env.PORT || 5000;
logger.info({ geminiConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()) }, "Gemini configuration loaded");

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "3mb" }));
app.use(pinoHttp({ logger }));

app.use("/api/items", itemRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/drafts", draftRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/documents", documentRoutes);

app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "AI Knowledge Inbox API is running",
    timestamp: new Date().toISOString(),
    data: {
      gemini: {
        configured: Boolean(process.env.GEMINI_API_KEY?.trim()),
        model: process.env.GEMINI_MODEL?.trim() || "gemini-3.6-flash",
      },
    },
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  logger.error({ err: error }, "Request failed");
  const status = error.status === 413 ? 413 : 500;
  res.status(status).json({
    success: false,
    message: status === 413 ? "Request body is too large." : "The request could not be completed.",
  });
});

app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  indexAllUnindexedItems().then((count) => {
    if (count > 0) logger.info({ indexedItems: count }, "Backfilled chunks and embeddings for existing knowledge items");
  }).catch((err) => {
    logger.error({ err }, "Initial knowledge indexing encountered an error");
  });
});