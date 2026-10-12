import { Router } from "express";
import {
    createChat,
    deleteChat,
    findConversationLinks,
    getChat,
    importChatHistory,
    listChatTrash,
    listChats,
    permanentlyDeleteChat,
    renameChat,
    restoreChat,
    sendChatMessage,
    summarizeConversation,
    updateChat,
} from "../controllers/chatController.js";

const router = Router();

router.get("/conversations", listChats);
router.post("/conversations", createChat);
router.get("/conversations/trash", listChatTrash);
router.post("/conversations/:id/summarize", summarizeConversation);
router.post("/conversations/:id/links", findConversationLinks);
router.get("/conversations/:id", getChat);
router.post("/conversations/:id/messages/import", importChatHistory);
router.patch("/conversations/:id", updateChat);
router.patch("/conversations/:id/title", renameChat);
router.patch("/conversations/:id/restore", restoreChat);
router.delete("/conversations/:id/permanent", permanentlyDeleteChat);
router.delete("/conversations/:id", deleteChat);
router.post("/", sendChatMessage);

export default router;