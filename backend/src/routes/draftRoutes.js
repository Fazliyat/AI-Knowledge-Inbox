import { Router } from "express";
import { getDrafts, removeDraft, saveDraft } from "../controllers/draftController.js";

const router = Router();

router.get("/", getDrafts);
router.post("/", saveDraft);
router.delete("/:id", removeDraft);

export default router;
