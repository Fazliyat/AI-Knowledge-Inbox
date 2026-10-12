import {
    addNoteDraft,
    deleteNoteDraft,
    listNoteDrafts,
} from "../repositories/chatRepository.js";

export function getDrafts(req, res, next) {
    try {
        return res.json({ success: true, data: listNoteDrafts() });
    } catch (error) {
        next(error);
    }
}

export function saveDraft(req, res, next) {
    try {
        const { id, title = "", content = "", sourceType = "note", sourceUrl = null } = req.body;
        if (id !== undefined && (typeof id !== "string" || id.length > 100)) {
            return res.status(400).json({ success: false, message: "Invalid draft ID." });
        }
        if ([title, content].some((value) => typeof value !== "string" || value.length > 20_000)) {
            return res.status(400).json({ success: false, message: "Draft fields must be text of at most 20,000 characters." });
        }
        if (!["note", "url"].includes(sourceType)) {
            return res.status(400).json({ success: false, message: "Draft type must be note or url." });
        }
        if (sourceUrl !== null && (typeof sourceUrl !== "string" || sourceUrl.length > 2_000)) {
            return res.status(400).json({ success: false, message: "Invalid draft URL." });
        }
        const draft = addNoteDraft({ id, title, content, sourceType, sourceUrl });
        return res.status(200).json({ success: true, data: draft });
    } catch (error) {
        next(error);
    }
}

export function removeDraft(req, res, next) {
    try {
        const result = deleteNoteDraft(req.params.id);
        if (!result.changes) return res.status(404).json({ success: false, message: "Draft not found." });
        return res.json({ success: true });
    } catch (error) {
        next(error);
    }
}
