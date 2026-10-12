import { Router } from "express";

import {
    addItem,
    deleteItem,
    getItem,
    listItems,
    listTrash,
    permanentlyDeleteItem,
    restoreItem,
    toggleFavorite,
    updateItem,
} from "../controllers/itemController.js";

const router = Router();

router.post("/", addItem);
router.get("/", listItems);
router.get("/trash", listTrash);
router.get("/:id", getItem);
router.patch("/:id/favorite", toggleFavorite);
router.patch("/:id/restore", restoreItem);
router.put("/:id", updateItem);
router.delete("/:id/permanent", permanentlyDeleteItem);
router.delete("/:id", deleteItem);

export default router;