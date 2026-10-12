import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { formatDate, parseUtcTimestamp } from "./utils/date.js";
import { cleanCitationMarkers } from "./utils/citation.js";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:5000/api";
const STORAGE_KEY = "knowledge-inbox-ai-conversations";
const MIGRATION_KEY = "knowledge-inbox-sqlite-conversation-migration-v1";
const DEFAULT_UPLOAD_CONFIG = {
  maxFileSize: 25 * 1024 * 1024,
  extensions: [
    ".pdf", ".doc", ".docx", ".txt", ".md", ".csv", ".xls", ".xlsx", ".json", ".xml",
    ".ppt", ".pptx", ".png", ".jpg", ".jpeg", ".webp", ".mp3", ".wav", ".m4a",
    ".mp4", ".webm", ".zip",
  ],
};

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: "▣" },
  { id: "all", label: "All Items", icon: "▤" },
  { id: "notes", label: "Notes", icon: "✎" },
  { id: "links", label: "Links", icon: "↗" },
  { id: "documents", label: "Documents", icon: "▣" },
  { id: "assistant", label: "AI Assistant", icon: "◌" },
  { id: "favorites", label: "Favorites", icon: "★" },
  { id: "recent", label: "Recent Items", icon: "◔" },
  { id: "drafts", label: "Drafts", icon: "▱" },
  { id: "trash", label: "Trash", icon: "⌫" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

function isValidUrl(value) {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function orderConversations(conversations) {
  return [...conversations].sort((left, right) =>
    (parseUtcTimestamp(right.updated_at)?.getTime() ?? 0) -
    (parseUtcTimestamp(left.updated_at)?.getTime() ?? 0)
  );
}

function getInitialConversations() {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
}

function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const formData = new FormData();
    formData.append("file", file);
    request.open("POST", `${API_BASE}/documents`);
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener("error", () => reject(new Error(`Could not upload ${file.name}. Check the backend connection.`)));
    request.addEventListener("load", () => {
      let payload;
      try {
        payload = JSON.parse(request.responseText);
      } catch {
        reject(new Error(`The server returned an invalid response for ${file.name}.`));
        return;
      }
      if (request.status < 200 || request.status >= 300 || !payload.success) {
        reject(new Error(payload.message || `Could not upload ${file.name}.`));
        return;
      }
      resolve(payload.data);
    });
    request.send(formData);
  });
}

function App() {
  const [items, setItems] = useState([]);
  const [itemsLoaded, setItemsLoaded] = useState(false);
  const [activeNav, setActiveNav] = useState("dashboard");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [form, setForm] = useState({
    title: "",
    content: "",
    sourceType: "note",
    sourceUrl: "",
    description: "",
    file: null,
  });
  const [conversations, setConversations] = useState(getInitialConversations);
  const [activeConversationId, setActiveConversationId] = useState(() => {
    const initial = getInitialConversations();
    return initial[0]?.id ?? null;
  });
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [assistantAction, setAssistantAction] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState("");
  const [draftId, setDraftId] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [trashItems, setTrashItems] = useState([]);
  const [trashConversations, setTrashConversations] = useState([]);
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchDeleteTarget, setSearchDeleteTarget] = useState(null);
  const [deletingSearchResult, setDeletingSearchResult] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [documentUploadConfig, setDocumentUploadConfig] = useState(DEFAULT_UPLOAD_CONFIG);
  const [geminiStatus, setGeminiStatus] = useState("checking");
  const [openedItem, setOpenedItem] = useState(null);
  const scrollAnchorRef = useRef(null);
  const chatInputRef = useRef(null);
  const cancelSearchDeleteRef = useRef(null);
  const creatingConversationRef = useRef(false);
  const assistantActionRef = useRef(false);
  const createdEmptyConversationRef = useRef(null);
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) || null;
  const visibleConversations = conversations.filter((conversation) =>
    conversation.messages?.length || conversation.draft_content || conversation.id === activeConversationId
  );

  const fetchItems = async () => {
    try {
      const response = await fetch(`${API_BASE}/items`);
      const payload = await response.json();

      if (!payload.success) {
        setErrorMessage(payload.message || "Could not load items.");
        setItemsLoaded(true);
        return;
      }

      setItems(payload.data || []);
      setItemsLoaded(true);
      setErrorMessage("");
    } catch {
      setErrorMessage("Unable to connect to the backend. Please start the API server.");
      setItemsLoaded(true);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      fetchItems();
      fetch(`${API_BASE}/health`)
        .then(async (response) => {
          const payload = await response.json();
          if (!response.ok || !payload.success) throw new Error("Could not check Gemini configuration.");
          setGeminiStatus(payload.data?.gemini?.configured ? "configured" : "missing");
        })
        .catch(() => setGeminiStatus("unavailable"));
      fetch(`${API_BASE}/documents/config`)
        .then(async (response) => {
          const payload = await response.json();
          if (!response.ok || !payload.success) throw new Error(payload.message || "Could not load document upload settings.");
          setDocumentUploadConfig(payload.data);
        })
        .catch((error) => setErrorMessage(error.message || "Could not load document upload settings."));
      fetch(`${API_BASE}/chat/conversations`)
        .then((response) => response.json())
        .then(async (payload) => {
          if (!payload.success) throw new Error(payload.message || "Could not load conversations.");
          let remote = payload.data || [];
          const migrationComplete = window.localStorage.getItem(MIGRATION_KEY) === "true";
          const legacy = migrationComplete ? [] : getInitialConversations().filter((conversation) =>
            conversation.messages?.length || conversation.draftContent || conversation.draft_content
          );
          const remoteIds = new Set(remote.map((conversation) => conversation.id));
          for (const conversation of legacy) {
            if (remoteIds.has(conversation.id)) continue;
            const created = await fetch(`${API_BASE}/chat/conversations`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                id: conversation.id,
                title: conversation.title || "New conversation",
                createdAt: conversation.createdAt || conversation.created_at,
                updatedAt: conversation.updatedAt || conversation.updated_at,
                draftContent: conversation.draft_content || conversation.draftContent || "",
              }),
            }).then((response) => response.json());
            const imported = await fetch(`${API_BASE}/chat/conversations/${created.data.id}/messages/import`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ messages: (conversation.messages || []).map((message) => ({
                ...message,
                created_at: message.created_at || message.createdAt,
              })) }),
            }).then((response) => response.json());
            if (!imported.success) throw new Error(imported.message || "Could not migrate an existing conversation.");
            remote = [imported.data, ...remote];
          }
          setConversations(orderConversations(remote));
          setActiveConversationId((current) =>
            remote.some((conversation) =>
              conversation.id === current && (conversation.messages?.length || conversation.draft_content)
            )
              ? current
              : remote.find((conversation) => conversation.messages?.length || conversation.draft_content)?.id ?? null
          );
          window.localStorage.setItem(MIGRATION_KEY, "true");
        })
        .catch((error) => setErrorMessage(error.message || "Unable to load chat history."));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    }
  }, [conversations]);

  useEffect(() => {
    if (activeNav !== "assistant" || !activeConversationId) return undefined;
    const timer = window.setTimeout(() => {
      fetch(`${API_BASE}/chat/conversations/${activeConversationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: activeConversation?.title || "New conversation",
          draftContent: chatInput,
        }),
      })
        .then(async (response) => {
          const payload = await response.json();
          if (!response.ok || !payload.success) {
            throw new Error(payload.message || "Could not save chat draft.");
          }
          setConversations((current) => orderConversations(current.map((conversation) =>
            conversation.id === activeConversationId ? payload.data : conversation
          )));
        })
        .catch((error) => setErrorMessage(error.message || "Could not save chat draft."));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [activeNav, activeConversationId, activeConversation?.title, chatInput]);

  useEffect(() => {
    if (activeNav === "assistant" && activeConversationId) {
      chatInputRef.current?.focus();
    }
  }, [activeNav, activeConversationId]);

  useEffect(() => {
    if (activeNav !== "drafts") return;
    fetch(`${API_BASE}/drafts`)
      .then((response) => response.json())
      .then((payload) => {
        if (!payload.success) throw new Error(payload.message || "Could not load drafts.");
        setDrafts(payload.data || []);
      })
      .catch((error) => setErrorMessage(error.message || "Could not load drafts."));
  }, [activeNav]);

  useEffect(() => {
    if (activeNav !== "trash") return;
    Promise.all([
      fetch(`${API_BASE}/items/trash`).then((response) => response.json()),
      fetch(`${API_BASE}/chat/conversations/trash`).then((response) => response.json()),
    ])
      .then(([itemsPayload, chatsPayload]) => {
        if (!itemsPayload.success || !chatsPayload.success) throw new Error("Could not load Trash.");
        setTrashItems(itemsPayload.data || []);
        setTrashConversations(chatsPayload.data || []);
      })
      .catch((error) => setErrorMessage(error.message || "Could not load Trash."));
  }, [activeNav]);

  useEffect(() => {
    const hasFormWork = form.title.trim() || form.content.trim() || form.sourceUrl.trim() || form.description?.trim();
    if (!hasFormWork || activeNav === "assistant" || activeNav === "dashboard" || activeNav === "settings" || form.sourceType === "document") return undefined;

    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`${API_BASE}/drafts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: draftId || undefined,
            title: form.title,
            content: form.sourceType === "note" ? form.content : (form.description || form.sourceUrl),
            sourceType: form.sourceType === "url" ? "url" : "note",
            sourceUrl: form.sourceUrl || null,
          }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error(payload.message || "Could not save draft.");
        setDraftId(payload.data.id);
      } catch (error) {
        setErrorMessage(error.message || "Could not save note draft.");
      }
    }, 600);
    return () => window.clearTimeout(timer);
  }, [form, draftId, activeNav]);

  useEffect(() => {
    if (!searchTerm.trim()) {
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setIsSearching(true);
      setSearchError("");
      try {
        const params = new URLSearchParams({ q: searchTerm.trim() });
        if (activeNav === "trash") params.set("trash", "true");
        const response = await fetch(`${API_BASE}/search?${params}`, { signal: controller.signal });
        const payload = await response.json();
        if (!response.ok || !payload.success) {
          throw new Error(payload.message || "Search failed.");
        }
        setSearchResults(payload.data || []);
      } catch (error) {
        if (error.name === "AbortError") return;
        setSearchResults([]);
        setSearchError(error.message || "Search failed.");
      } finally {
        if (!controller.signal.aborted) setIsSearching(false);
      }
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [searchTerm, activeNav]);

  useEffect(() => {
    if (scrollAnchorRef.current) {
      scrollAnchorRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [activeConversationId, conversations]);

  useEffect(() => {
    if (!searchDeleteTarget) return undefined;
    cancelSearchDeleteRef.current?.focus();
    const handleDialogKeyDown = (event) => {
      if (event.key === "Escape" && !deletingSearchResult) {
        setSearchDeleteTarget(null);
      } else if (event.key === "Tab") {
        event.preventDefault();
        const buttons = event.currentTarget.querySelectorAll("button:not(:disabled)");
        const currentIndex = Array.from(buttons).indexOf(document.activeElement);
        const nextIndex = event.shiftKey
          ? (currentIndex <= 0 ? buttons.length - 1 : currentIndex - 1)
          : (currentIndex + 1) % buttons.length;
        buttons[nextIndex]?.focus();
      }
    };
    const dialog = document.querySelector("[data-search-delete-dialog]");
    dialog?.addEventListener("keydown", handleDialogKeyDown);
    return () => dialog?.removeEventListener("keydown", handleDialogKeyDown);
  }, [searchDeleteTarget, deletingSearchResult]);

  const visibleItems = useMemo(() => {
    let filtered = [...items];

    if (activeNav === "notes") {
      filtered = filtered.filter((item) => item.source_type === "note");
    }

    if (activeNav === "links") {
      filtered = filtered.filter((item) => item.source_type === "url");
    }

    if (activeNav === "documents") {
      filtered = filtered.filter((item) => item.source_type === "document");
    }

    if (activeNav === "favorites") {
      filtered = filtered.filter((item) => Number(item.favorite) === 1);
    }

    if (activeNav === "recent") {
      filtered = filtered
        .sort((a, b) => (parseUtcTimestamp(b.updated_at || b.created_at)?.getTime() ?? 0) -
          (parseUtcTimestamp(a.updated_at || a.created_at)?.getTime() ?? 0))
        .slice(0, 8);
    }

    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter((item) => {
        const haystack = `${item.title} ${item.content} ${item.source_url || ""}`.toLowerCase();
        return haystack.includes(term);
      });
    }

    return filtered;
  }, [items, activeNav, searchTerm]);

  const stats = useMemo(() => {
    return {
      total: items.length,
      notes: items.filter((item) => item.source_type === "note").length,
      links: items.filter((item) => item.source_type === "url").length,
      documents: items.filter((item) => item.source_type === "document").length,
      favorites: items.filter((item) => Number(item.favorite) === 1).length,
    };
  }, [items]);

  const recentItems = useMemo(() => {
    return [...items]
      .sort((a, b) => (parseUtcTimestamp(b.created_at || b.updated_at)?.getTime() ?? 0) -
        (parseUtcTimestamp(a.created_at || a.updated_at)?.getTime() ?? 0))
      .slice(0, 4);
  }, [items]);

  const favoriteItems = useMemo(() => {
    return items.filter((item) => Number(item.favorite) === 1).slice(0, 4);
  }, [items]);
  const hasSearchQuery = Boolean(searchTerm.trim());

  function setFormValue(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function handleNavChange(navId) {
    void persistActiveChatDraft();
    void persistCurrentNoteDraft();
    setSearchTerm("");
    setActiveNav(navId);
    if (navId === "notes") setFormValue("sourceType", "note");
    else if (navId === "links") setFormValue("sourceType", "url");
    else if (navId === "documents") setFormValue("sourceType", "document");
    if (navId === "dashboard") void fetchItems();
  }

  function handleSearchChange(value) {
    setSearchTerm(value);
    setSearchError("");
    if (value.trim()) {
      setIsSearching(true);
      setSearchResults([]);
    } else {
      setIsSearching(false);
      setSearchResults([]);
    }
  }

  function handleDocumentFileSelect(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const allowed = new Set(documentUploadConfig.extensions);
    const extension = `.${file.name.split(".").pop()?.toLowerCase()}`;
    if (!allowed.has(extension)) {
      setErrorMessage(`${file.name} has an unsupported file extension.`);
      event.target.value = "";
      return;
    }
    if (file.size > documentUploadConfig.maxFileSize) {
      setErrorMessage(`${file.name} exceeds the ${Math.floor(documentUploadConfig.maxFileSize / (1024 * 1024))} MB limit.`);
      event.target.value = "";
      return;
    }
    if (file.size === 0) {
      setErrorMessage(`${file.name} is empty.`);
      event.target.value = "";
      return;
    }
    setErrorMessage("");
    setForm((current) => ({
      ...current,
      file,
      title: current.title.trim() ? current.title : file.name.replace(/\.[^.]+$/, ""),
    }));
  }

  async function handleSaveItem(event) {
    event.preventDefault();

    const titleToSave = form.title.trim() || (form.file ? form.file.name.replace(/\.[^.]+$/, "") : "");

    if (!titleToSave) {
      setErrorMessage("Please enter a title.");
      return;
    }

    if (form.sourceType === "note") {
      if (!form.content.trim()) {
        setErrorMessage("Please enter note content.");
        return;
      }
    } else if (form.sourceType === "url") {
      if (!form.sourceUrl.trim() || !isValidUrl(form.sourceUrl.trim())) {
        setErrorMessage("Please enter a valid HTTP or HTTPS URL.");
        return;
      }
    } else if (form.sourceType === "document") {
      if (!form.file) {
        setErrorMessage("Please choose a document file to upload.");
        return;
      }
    }

    setSaving(true);
    setUploadProgress(0);
    setErrorMessage("");

    try {
      let savedItem;

      if (form.sourceType === "document") {
        savedItem = await new Promise((resolve, reject) => {
          const request = new XMLHttpRequest();
          const formData = new FormData();
          formData.append("file", form.file);
          formData.append("title", titleToSave);
          formData.append("content", (form.description || "").trim());
          formData.append("sourceType", "document");

          request.open("POST", `${API_BASE}/documents`);
          request.upload.addEventListener("progress", (e) => {
            if (e.lengthComputable) {
              setUploadProgress(Math.round((e.loaded / e.total) * 100));
            }
          });
          request.addEventListener("error", () => reject(new Error("Upload failed. Check the backend connection.")));
          request.addEventListener("load", () => {
            let payload;
            try {
              payload = JSON.parse(request.responseText);
            } catch {
              reject(new Error("The server returned an invalid response."));
              return;
            }
            if (request.status < 200 || request.status >= 300 || !payload.success) {
              reject(new Error(payload.message || "Could not save document."));
              return;
            }
            resolve(payload.data);
          });
          request.send(formData);
        });
      } else {
        const payload = {
          title: titleToSave,
          content: form.sourceType === "note"
            ? form.content.trim()
            : (form.description.trim() || form.sourceUrl.trim()),
          sourceType: form.sourceType,
          sourceUrl: form.sourceType === "url" ? form.sourceUrl.trim() : null,
        };

        const response = await fetch(`${API_BASE}/items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const result = await response.json();

        if (!response.ok || result.success === false) {
          throw new Error(result.message || "Could not save item.");
        }
        savedItem = result.data;
      }

      setItems((current) => [savedItem, ...current.filter((entry) => entry.id !== savedItem.id)]);
      setForm({
        title: "",
        content: "",
        sourceType: form.sourceType,
        sourceUrl: "",
        description: "",
        file: null,
      });

      const fileInput = document.getElementById("item-file");
      if (fileInput) fileInput.value = "";

      if (draftId) {
        await fetch(`${API_BASE}/drafts/${draftId}`, { method: "DELETE" }).catch(() => {});
        setDraftId(null);
      }
      setSuccessMessage("Saved successfully.");
      setTimeout(() => setSuccessMessage(""), 2500);
    } catch (error) {
      setErrorMessage(error.message || "Something went wrong while saving.");
    } finally {
      setSaving(false);
      setUploadProgress(0);
    }
  }

  async function handleDeleteItem(item) {
    const confirmed = window.confirm("Delete this saved item?");
    if (!confirmed) return;

    try {
      const response = await fetch(`${API_BASE}/items/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceType: item.source_type }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.message || "Unable to move item to Trash.");
      }
      setItems((current) => current.filter((entry) => String(entry.id) !== String(item.id)));
      setSearchResults((current) => current.filter((entry) =>
        !(String(entry.result_id) === String(item.id) && entry.result_type === item.source_type)
      ));
      setTrashItems((current) => [{
        ...item,
        trashed_at: new Date().toISOString(),
      }, ...current.filter((entry) => String(entry.id) !== String(item.id))]);
      setSuccessMessage(`“${item.title}” moved to Trash.`);
      window.setTimeout(() => setSuccessMessage(""), 2500);
      return true;
    } catch (error) {
      setErrorMessage(error.message || "Unable to move item to Trash.");
      return false;
    }
  }

  async function handleFavoriteToggle(item) {
    const nextValue = !(Number(item.favorite) === 1);
    try {
      const response = await fetch(`${API_BASE}/items/${item.id}/favorite`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ favorite: nextValue }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || "Unable to update favorite state.");
      setItems((current) => current.map((entry) =>
        entry.id === item.id ? { ...entry, favorite: nextValue ? 1 : 0 } : entry
      ));
      setOpenedItem((current) => current?.id === item.id
        ? { ...current, favorite: nextValue ? 1 : 0 }
        : current);
    } catch (error) {
      setErrorMessage(error.message || "Unable to update favorites.");
    }
  }

  async function handleEditItem(item) {
    const title = window.prompt("Edit item title", item.title);
    if (title === null) return;
    const isUrl = item.source_type === "url";
    const isDoc = item.source_type === "document";

    let contentInput;
    let urlInput = null;

    if (isUrl) {
      urlInput = window.prompt("Edit URL", item.source_url || "");
      if (urlInput === null) return;
      if (!urlInput.trim() || !isValidUrl(urlInput.trim())) {
        setErrorMessage("Please enter a valid HTTP or HTTPS URL.");
        return;
      }
      const descInput = window.prompt("Edit description (optional)", item.content !== item.source_url ? item.content : "");
      if (descInput === null) return;
      contentInput = descInput.trim() || urlInput.trim();
    } else if (isDoc) {
      contentInput = window.prompt("Edit document notes or description", item.content || "");
      if (contentInput === null) return;
    } else {
      contentInput = window.prompt("Edit content", item.content || "");
      if (contentInput === null) return;
      if (!contentInput.trim()) {
        setErrorMessage("Content is required for notes.");
        return;
      }
    }

    if (!title.trim()) {
      setErrorMessage("Please enter a title.");
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/items/${item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          content: contentInput.trim(),
          sourceType: item.source_type,
          sourceUrl: isUrl ? urlInput.trim() : null,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || "Could not update item.");
      setItems((current) => current.map((entry) => entry.id === item.id ? payload.data : entry));
      setSearchResults((current) => current.map((entry) =>
        entry.result_id === item.id ? { ...entry, ...payload.data, result_type: payload.data.source_type } : entry
      ));
      setOpenedItem((current) => current?.id === item.id ? payload.data : current);
      setSuccessMessage("Item updated.");
      setTimeout(() => setSuccessMessage(""), 2500);
    } catch (error) {
      setErrorMessage(error.message || "Could not update item.");
    }
  }

  async function restoreItem(item) {
    try {
      const response = await fetch(`${API_BASE}/items/${item.id}/restore`, { method: "PATCH" });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || "Could not restore item.");
      setTrashItems((current) => current.filter((entry) => entry.id !== item.id));
      setItems((current) => [payload.data, ...current]);
      setSearchResults((current) => current.filter((entry) => entry.result_id !== item.id));
    } catch (error) {
      setErrorMessage(error.message || "Could not restore item.");
    }
  }

  async function permanentlyDeleteItem(item) {
    if (!window.confirm("Permanently delete this item? This cannot be undone.")) return;
    try {
      const response = await fetch(`${API_BASE}/items/${item.id}/permanent`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || "Could not permanently delete item.");
      setTrashItems((current) => current.filter((entry) => entry.id !== item.id));
      setSearchResults((current) => current.filter((entry) => entry.result_id !== item.id));
    } catch (error) {
      setErrorMessage(error.message || "Could not permanently delete item.");
    }
  }

  async function restoreConversation(conversation) {
    try {
      const response = await fetch(`${API_BASE}/chat/conversations/${conversation.id}/restore`, { method: "PATCH" });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || "Could not restore conversation.");
      setTrashConversations((current) => current.filter((entry) => entry.id !== conversation.id));
      const refreshed = await fetch(`${API_BASE}/chat/conversations/${conversation.id}`).then((res) => res.json());
      if (refreshed.success) setConversations((current) => orderConversations([refreshed.data, ...current]));
      setSearchResults((current) => current.filter((entry) => entry.result_id !== conversation.id));
    } catch (error) {
      setErrorMessage(error.message || "Could not restore conversation.");
    }
  }

  async function permanentlyDeleteConversation(conversation) {
    if (!window.confirm("Permanently delete this conversation? This cannot be undone.")) return;
    try {
      const response = await fetch(`${API_BASE}/chat/conversations/${conversation.id}/permanent`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || "Could not permanently delete conversation.");
      setTrashConversations((current) => current.filter((entry) => entry.id !== conversation.id));
      setSearchResults((current) => current.filter((entry) => entry.result_id !== conversation.id));
    } catch (error) {
      setErrorMessage(error.message || "Could not permanently delete conversation.");
    }
  }

  async function persistActiveChatDraft() {
    if (!activeConversationId || !chatInput.trim()) return true;
    try {
      const response = await fetch(`${API_BASE}/chat/conversations/${activeConversationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: conversations.find((conversation) => conversation.id === activeConversationId)?.title || "New conversation",
          draftContent: chatInput,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || "Could not save conversation draft.");
      setConversations((current) => orderConversations(current.map((conversation) =>
        conversation.id === activeConversationId ? payload.data : conversation
      )));
      return true;
    } catch (error) {
      setErrorMessage(error.message || "Could not save conversation draft.");
      return false;
    }
  }

  async function persistCurrentNoteDraft() {
    const hasWork = form.title.trim() || form.content.trim() || form.sourceUrl.trim() || form.description?.trim();
    if (!hasWork || ["assistant", "dashboard", "settings", "drafts", "trash"].includes(activeNav) || form.sourceType === "document") return;
    try {
      const response = await fetch(`${API_BASE}/drafts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: draftId || undefined,
          title: form.title,
          content: form.sourceType === "note" ? form.content : (form.description || form.sourceUrl),
          sourceType: form.sourceType === "url" ? "url" : "note",
          sourceUrl: form.sourceUrl || null,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || "Could not save note draft.");
      setDraftId(payload.data.id);
    } catch (error) {
      setErrorMessage(error.message || "Could not save note draft.");
    }
  }

  async function createConversation() {
    if (creatingConversationRef.current) return;
    if (
      activeNav === "assistant" &&
      activeConversationId === createdEmptyConversationRef.current &&
      activeConversation &&
      activeConversation.messages?.length === 0 &&
      !activeConversation.draft_content &&
      !chatInput.trim()
    ) {
      chatInputRef.current?.focus();
      return;
    }
    creatingConversationRef.current = true;
    try {
      if (!(await persistActiveChatDraft())) return;
      await persistCurrentNoteDraft();
      const response = await fetch(`${API_BASE}/chat/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New conversation" }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || "Could not create a conversation.");
      setConversations((current) => orderConversations([payload.data, ...current]));
      setActiveConversationId(payload.data.id);
      createdEmptyConversationRef.current = payload.data.id;
      setChatInput("");
      setSearchTerm("");
      setActiveNav("assistant");
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(error.message || "Could not create a conversation.");
    } finally {
      creatingConversationRef.current = false;
    }
  }

  async function openConversation(conversationId) {
    if (!(await persistActiveChatDraft())) return;
    await persistCurrentNoteDraft();
    try {
      const response = await fetch(`${API_BASE}/chat/conversations/${conversationId}`);
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || "Could not open conversation.");
      setConversations((current) => orderConversations(current.map((conversation) =>
        conversation.id === conversationId ? payload.data : conversation
      )));
      setActiveConversationId(conversationId);
      setChatInput(payload.data.draft_content || "");
      setSearchTerm("");
      setActiveNav("assistant");
    } catch (error) {
      setErrorMessage(error.message || "Could not open conversation.");
    }
  }

  function renameConversation() {
    if (!activeConversation) return;

    const nextTitle = window.prompt("Rename conversation", activeConversation.title || "New conversation");
    if (!nextTitle) return;
    fetch(`${API_BASE}/chat/conversations/${activeConversation.id}/title`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: nextTitle.trim() }),
    })
      .then((response) => response.json())
      .then((payload) => {
        if (!payload.success) throw new Error(payload.message || "Could not rename conversation.");
        setConversations((current) => orderConversations(current.map((conversation) =>
          conversation.id === activeConversation.id ? payload.data : conversation
        )));
        setSearchResults((current) => current.map((entry) =>
          entry.result_type === "conversation" && entry.result_id === activeConversation.id
            ? { ...entry, title: payload.data.title, updated_at: payload.data.updated_at }
            : entry
        ));
      })
      .catch((error) => setErrorMessage(error.message || "Could not rename conversation."));
  }

  async function deleteConversation() {
    if (!activeConversation) return;
    await moveConversationToTrash(activeConversation);
  }

  async function moveConversationToTrash(conversation) {
    if (!conversation || !window.confirm(`Move "${conversation.title || "New conversation"}" to Trash?`)) return;
    if (conversation.id === activeConversationId && !(await persistActiveChatDraft())) return;
    try {
      const response = await fetch(`${API_BASE}/chat/conversations/${conversation.id}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || "Could not move conversation to Trash.");
      const remaining = conversations.filter((entry) => entry.id !== conversation.id);
      setConversations(remaining);
      setTrashConversations((current) => [{
        id: conversation.id,
        title: conversation.title || "New conversation",
        created_at: conversation.created_at,
        updated_at: conversation.updated_at,
        trashed_at: new Date().toISOString(),
      }, ...current.filter((entry) => entry.id !== conversation.id)]);
      if (conversation.id === activeConversationId) {
        setActiveConversationId(remaining[0]?.id ?? null);
        setChatInput("");
        if (remaining.length) {
          const nextResponse = await fetch(`${API_BASE}/chat/conversations/${remaining[0].id}`);
          const nextPayload = await nextResponse.json();
          if (!nextResponse.ok || !nextPayload.success) {
            throw new Error(nextPayload.message || "Conversation was moved to Trash, but the next conversation could not be opened.");
          }
          setConversations((current) => orderConversations(current.map((entry) =>
            entry.id === nextPayload.data.id ? nextPayload.data : entry
          )));
          setChatInput(nextPayload.data.draft_content || "");
        }
        setActiveNav("assistant");
      }
    } catch (error) {
      setErrorMessage(error.message || "Could not move conversation to Trash.");
    }
  }

  async function sendChatMessage(event) {
    event.preventDefault();

    const trimmedMessage = chatInput.trim();

    if (!trimmedMessage) {
      return;
    }

    let conversationId = activeConversationId;
    if (!conversationId) {
      try {
        const createdResponse = await fetch(`${API_BASE}/chat/conversations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "New conversation" }),
        });
        const createdPayload = await createdResponse.json();
        if (!createdResponse.ok || !createdPayload.success) throw new Error(createdPayload.message || "Could not start a conversation.");
        conversationId = createdPayload.data.id;
        setActiveConversationId(conversationId);
        setConversations((current) => orderConversations([createdPayload.data, ...current]));
      } catch (error) {
        setErrorMessage(error.message || "Could not start a conversation.");
        return;
      }
    }

    setChatLoading(true);

    try {
      const response = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, message: trimmedMessage }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || "The AI request failed.");
      setConversations((current) => orderConversations(current.map((conversation) =>
        conversation.id === conversationId ? payload.data : conversation
      )));
      setChatInput("");
      setErrorMessage("");
    } catch (error) {
      const persisted = await fetch(`${API_BASE}/chat/conversations/${conversationId}`)
        .then((response) => response.json())
        .catch(() => null);
      if (persisted?.success) {
        setConversations((current) => orderConversations(current.map((conversation) =>
          conversation.id === conversationId ? persisted.data : conversation
        )));
      }
      await fetch(`${API_BASE}/chat/conversations/${conversationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftContent: trimmedMessage }),
      }).catch(() => null);
      setErrorMessage(error.message || "The AI chat request failed.");
    } finally {
      setChatLoading(false);
    }
  }

  async function runAssistantAction(action) {
    if (assistantActionRef.current || chatLoading) return;
    if (!activeConversationId) {
      setErrorMessage("Start or select a conversation before using this assistant action.");
      return;
    }

    assistantActionRef.current = true;
    setChatLoading(true);
    setAssistantAction(action);
    setErrorMessage("");
    try {
      const endpoint = action === "summarize" ? "summarize" : "links";
      const response = await fetch(`${API_BASE}/chat/conversations/${encodeURIComponent(activeConversationId)}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: chatInput.trim() }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.message || (action === "summarize"
          ? "Could not summarize this conversation."
          : "Could not find relevant links."));
      }
      setConversations((current) => orderConversations(current.map((conversation) =>
        conversation.id === activeConversationId ? payload.data : conversation
      )));
    } catch (error) {
      setErrorMessage(error.message || "The assistant action failed.");
    } finally {
      assistantActionRef.current = false;
      setAssistantAction("");
      setChatLoading(false);
    }
  }

  async function handleCopyContent(text, id) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageId(id);
      setTimeout(() => setCopiedMessageId(""), 1800);
    } catch {
      setErrorMessage("Clipboard access was blocked in this browser.");
    }
  }

  async function handleCitationClick(source) {
    if (!source) return;
    if (!source.id) {
      if (source.url && isValidUrl(source.url)) {
        window.open(source.url, "_blank", "noopener,noreferrer");
      }
      return;
    }

    // 1. Check if the full item is already in local items state
    const localMatch = items.find((entry) => String(entry.id) === String(source.id));
    if (localMatch) {
      setOpenedItem(localMatch);
      return;
    }

    // 2. Otherwise fetch the complete item from the API
    try {
      const response = await fetch(`${API_BASE}/items/${encodeURIComponent(source.id)}`);
      const payload = await response.json();
      if (response.ok && payload.success && payload.data) {
        setOpenedItem(payload.data);
      } else {
        setErrorMessage(`Source #${source.id} (“${source.title || "Untitled"}”) is no longer accessible or has been deleted.`);
      }
    } catch {
      if (source.title || source.content) {
        setOpenedItem({
          id: source.id,
          title: source.title || `Source #${source.id}`,
          content: source.content || "Content unavailable.",
          source_type: source.type || "note",
          source_url: source.url || null,
        });
      } else {
        setErrorMessage(`Source #${source.id} could not be loaded.`);
      }
    }
  }

  function openSearchResult(result) {
    if (result.trashed_at) {
      setSearchTerm("");
      setActiveNav("trash");
      setOpenedItem(result.result_type === "conversation" ? null : result);
      return;
    }
    if (result.result_type === "conversation") {
      void openConversation(result.result_id);
      return;
    }
    setOpenedItem({ ...result, source_type: result.source_type || result.result_type });
  }

  async function moveSearchResultToTrash(result) {
    if (deletingSearchResult) return;
    setDeletingSearchResult(true);
    setErrorMessage("");
    const isConversation = result.result_type === "conversation";
    const itemType = result.source_type || result.result_type;
    const endpoint = isConversation
      ? `${API_BASE}/chat/conversations/${encodeURIComponent(result.result_id)}`
      : `${API_BASE}/items/${encodeURIComponent(result.result_id)}`;
    const wasActiveConversation = isConversation && result.result_id === activeConversationId;

    try {
      if (wasActiveConversation && !(await persistActiveChatDraft())) return;
      const response = await fetch(endpoint, {
        method: "DELETE",
        ...(isConversation ? {} : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceType: itemType }),
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.message || "Could not move this result to Trash.");
      }
      setSearchResults((current) => current.filter((entry) =>
        !(entry.result_type === result.result_type && entry.result_id === result.result_id)
      ));
      if (isConversation) {
        const remaining = conversations.filter((entry) => entry.id !== result.result_id);
        setConversations(remaining);
        setTrashConversations((current) => [{
          id: result.result_id,
          title: result.title,
          created_at: result.created_at,
          updated_at: result.updated_at,
          trashed_at: new Date().toISOString(),
        }, ...current.filter((entry) => entry.id !== result.result_id)]);
        if (wasActiveConversation) {
          setActiveConversationId(remaining[0]?.id ?? null);
          setChatInput(remaining[0]?.draft_content || "");
        }
      } else {
        setItems((current) => current.filter((entry) => entry.id !== result.result_id));
        setTrashItems((current) => [{
          ...result,
          id: result.result_id,
          source_type: itemType,
          trashed_at: new Date().toISOString(),
        }, ...current.filter((entry) => entry.id !== result.result_id)]);
      }
      setSuccessMessage(`“${result.title}” moved to Trash.`);
      setSearchDeleteTarget(null);
    } catch (error) {
      setErrorMessage(error.message || "Could not move this result to Trash.");
    } finally {
      setDeletingSearchResult(false);
    }
  }

  async function handleFileSelection(event) {
    const files = Array.from(event.target.files || []);
    void persistActiveChatDraft();
    void persistCurrentNoteDraft();
    const allowed = new Set(documentUploadConfig.extensions);
    const selected = files.filter((file) => {
      const extension = `.${file.name.split(".").pop()?.toLowerCase()}`;
      return allowed.has(extension) && file.size > 0 && file.size <= documentUploadConfig.maxFileSize;
    });
    const rejected = files.filter((file) => !selected.includes(file)).map((file) => {
      if (file.size > documentUploadConfig.maxFileSize) {
        return `${file.name} exceeds the ${Math.floor(documentUploadConfig.maxFileSize / (1024 * 1024))} MB limit.`;
      }
      if (!file.size) return `${file.name} is empty.`;
      return `${file.name} has an unsupported file type.`;
    });
    if (rejected.length) {
      setErrorMessage(rejected.join(" "));
    }

    if (!selected.length) return;

    setUploading(true);
    setUploadProgress(0);
    let importedCount = 0;
    const failedFiles = [];
    try {
      for (const [index, file] of selected.entries()) {
        try {
          const item = await uploadFile(file, (percent) => {
            setUploadProgress(Math.round(((index + percent / 100) / selected.length) * 100));
          });
          setItems((current) => [item, ...current.filter((entry) => entry.id !== item.id)]);
        } catch (error) {
          failedFiles.push(error.message || `Could not upload ${file.name}.`);
        }
        importedCount += 1;
      }
      const successfulCount = importedCount - failedFiles.length;
      if (successfulCount) {
        setSuccessMessage(`${successfulCount} document${successfulCount === 1 ? "" : "s"} uploaded. Text was indexed when extraction was supported.`);
        setActiveNav("documents");
      }
      if (failedFiles.length) setErrorMessage([...rejected, ...failedFiles].join(" "));
      else if (!rejected.length) setErrorMessage("");
    } finally {
      setUploading(false);
      setUploadProgress(0);
      event.target.value = "";
    }
  }

  function renderItemCard(item) {
    const isFavorite = Number(item.favorite) === 1;
    const isUrl = item.source_type === "url";
    const isDocument = item.source_type === "document";

    return (
      <article className="item-card" key={item.id}>
        <div className="item-card-topline">
          <span className="item-type">{isUrl ? "Link" : isDocument ? "Document" : "Note"}</span>
          <button
            className={`favorite-button ${isFavorite ? "is-favorite" : ""}`}
            type="button"
            aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
            onClick={() => handleFavoriteToggle(item)}
          >
            {isFavorite ? "★" : "☆"}
          </button>
        </div>

        <h3>{item.title}</h3>

        {isUrl && isValidUrl(item.source_url || "") ? (
          <div>
            <a className="item-url" href={item.source_url} target="_blank" rel="noreferrer">
              {item.source_url}
            </a>
            {item.content && item.content !== item.source_url && (
              <p className="item-content" style={{ marginTop: "8px" }}>{item.content}</p>
            )}
          </div>
        ) : isDocument ? (
          <div>
            <p className="item-content" style={{ fontWeight: 600, color: "#94a3b8", marginBottom: "4px" }}>
              📄 {item.original_file_name || (item.content ? "Imported text document" : "Uploaded file")}
              {item.processing_status === "processed"
                ? " · Text extracted"
                : item.file_id
                  ? " · Stored"
                  : " · Text import"}
            </p>
            {item.content && (
              <p className="item-content">{item.content.length > 280 ? `${item.content.slice(0, 280)}…` : item.content}</p>
            )}
          </div>
        ) : (
          <p className="item-content">{item.content}</p>
        )}

        <div className="item-meta">
          <span>{isDocument ? "Uploaded" : "Created"} · {formatDate(item.uploaded_at || item.created_at)}</span>
          <details className="item-menu">
            <summary aria-label={`Actions for ${item.title}`} title="Item actions">•••</summary>
            <div className="item-menu-options">
              <button type="button" onClick={() => setOpenedItem(item)}>Open</button>
              {isDocument && item.file_id && (
                <a href={`${API_BASE}/documents/${item.id}/download`}>Download original</a>
              )}
              <button type="button" onClick={() => handleEditItem(item)}>Edit</button>
              <button type="button" onClick={() => handleFavoriteToggle(item)}>
                {isFavorite ? "Remove from Favorites" : "Add to Favorites"}
              </button>
              <button type="button" onClick={() => void handleDeleteItem(item)}>Delete</button>
            </div>
          </details>
        </div>
      </article>
    );
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
        <button
          type="button"
          className="sidebar-header brand-button"
          title="Go to Dashboard"
          onClick={() => handleNavChange("dashboard")}
        >
          <div className="brand-mark">K</div>
          {!sidebarCollapsed && (
            <div>
              <div className="brand-name">Knowledge Inbox AI</div>
            </div>
          )}
        </button>

        <button className="nav-action primary" type="button" onClick={createConversation}>
          {sidebarCollapsed ? "+" : "+ New Chat"}
        </button>

        <nav className="sidebar-nav" aria-label="Sidebar navigation">
          {NAV_ITEMS.map((navItem) => (
            <button
              key={navItem.id}
              type="button"
              className={`nav-item ${activeNav === navItem.id ? "active" : ""}`}
              title={navItem.label}
              onClick={() => handleNavChange(navItem.id)}
            >
              <span>{navItem.icon}</span>
              {!sidebarCollapsed && <span>{navItem.label}</span>}
            </button>
          ))}
        </nav>

        {!sidebarCollapsed && (
          <div className="sidebar-history">
            <div className="sidebar-history-heading">
              <p className="eyebrow">Recent chats</p>
              <button
                type="button"
                className="history-new-button"
                aria-label="Start a new conversation"
                title="Start a new conversation"
                onClick={() => void createConversation()}
              >+</button>
            </div>
            {visibleConversations.slice(0, 6).map((conversation) => (
              <button
                type="button"
                key={conversation.id}
                className={`history-link ${conversation.id === activeConversationId ? "active" : ""}`}
                onClick={() => openConversation(conversation.id)}
              >
                <span>{conversation.title || "New conversation"}</span>
                <span className="history-meta">
                  <small>{formatDate(conversation.updated_at)}</small>
                  {conversation.draft_content && <small>Draft</small>}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="sidebar-footer">
          <button className="nav-toggle" type="button" onClick={() => setSidebarCollapsed((value) => !value)}>
            {sidebarCollapsed ? "→" : "←"}
          </button>
        </div>
      </aside>

      <main className="main-app">
        <header className="topbar">
          <div>
            <p className="eyebrow">Knowledge management</p>
            <h1>Knowledge Inbox AI</h1>
          </div>

          <div className="topbar-actions">
            <label className="search-wrap" aria-label="Search items">
              <span>⌕</span>
              <input
                type="search"
                value={searchTerm}
                onChange={(event) => handleSearchChange(event.target.value)}
                placeholder="Search saved knowledge"
              />
            </label>
            <button
              type="button"
              className="icon-button home-button"
              onClick={() => {
                void persistActiveChatDraft();
                void persistCurrentNoteDraft();
                setActiveNav("dashboard");
                setSearchTerm("");
                void fetchItems();
              }}
            >Home</button>
          </div>
        </header>

        {errorMessage && <div className="message error">{errorMessage}</div>}
        {successMessage && <div className="message success">{successMessage}</div>}

        {openedItem && (
          <div className="item-dialog-backdrop" onClick={() => setOpenedItem(null)}>
            <section
              className="item-dialog card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="opened-item-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="panel-header">
                <div>
                  <p className="eyebrow">{openedItem.source_type || openedItem.result_type || "Saved item"} · #{openedItem.id}</p>
                  <h2 id="opened-item-title">{openedItem.title}</h2>
                </div>
                <button type="button" className="icon-button" aria-label="Close item details" onClick={() => setOpenedItem(null)}>×</button>
              </div>
              {openedItem.source_type === "url" && isValidUrl(openedItem.source_url || openedItem.url || "") && (
                <a
                  className="item-url"
                  href={openedItem.source_url || openedItem.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >{openedItem.source_url || openedItem.url}</a>
              )}
              <p className="item-content">{openedItem.content || "No content available."}</p>
              <div className="item-dialog-meta">
                <span>Created {formatDate(openedItem.created_at)}</span>
                {openedItem.trashed_at && <span>Deleted {formatDate(openedItem.trashed_at)}</span>}
                {openedItem.source_type === "document" && (
                  <>
                    {openedItem.original_file_name && <span>File {openedItem.original_file_name}</span>}
                    {openedItem.mime_type && <span>Type {openedItem.mime_type}</span>}
                    {openedItem.file_size != null && <span>{Math.ceil(openedItem.file_size / 1024)} KB</span>}
                    {openedItem.uploaded_at && <span>Uploaded {formatDate(openedItem.uploaded_at)}</span>}
                    <span>
                      {openedItem.processing_status === "processed"
                        ? "Text extracted and indexed"
                        : openedItem.file_id
                          ? "Original stored; text extraction is unavailable for this file type"
                          : "Legacy text import; original file is unavailable"}
                    </span>
                    {openedItem.file_id && !openedItem.trashed_at && (
                      <a className="text-button" href={`${API_BASE}/documents/${openedItem.id}/download`}>Download original</a>
                    )}
                  </>
                )}
              </div>
              <div className="draft-actions">
                {openedItem.trashed_at ? (
                  <>
                    {openedItem.source_type === "conversation" ? (
                      <button type="button" className="text-button" onClick={() => {
                        void restoreConversation({ id: openedItem.id });
                        setOpenedItem(null);
                      }}>Restore</button>
                    ) : (
                      <button type="button" className="text-button" onClick={() => {
                        void restoreItem(openedItem);
                        setOpenedItem(null);
                      }}>Restore</button>
                    )}
                    <button type="button" className="text-button danger" onClick={() => {
                      if (openedItem.source_type === "conversation") {
                        void permanentlyDeleteConversation({ id: openedItem.id });
                      } else {
                        void permanentlyDeleteItem(openedItem);
                      }
                      setOpenedItem(null);
                    }}>Delete permanently</button>
                  </>
                ) : (
                  <>
                    {openedItem.source_type === "url" && isValidUrl(openedItem.source_url || openedItem.url || "") && (
                      <a className="text-button" href={openedItem.source_url || openedItem.url} target="_blank" rel="noopener noreferrer">Open link</a>
                    )}
                    {openedItem.source_type !== "conversation" && (
                      <>
                        <button type="button" className="text-button" onClick={() => void handleEditItem(openedItem)}>Edit</button>
                        <button type="button" className="text-button" onClick={() => void handleFavoriteToggle(openedItem)}>
                          {Number(openedItem.favorite) === 1 ? "Remove from Favorites" : "Add to Favorites"}
                        </button>
                        <button type="button" className="text-button danger" onClick={() => {
                          void handleDeleteItem(openedItem).then((deleted) => {
                            if (deleted) setOpenedItem(null);
                          });
                        }}>Delete</button>
                      </>
                    )}
                  </>
                )}
              </div>
            </section>
          </div>
        )}

        {searchDeleteTarget && (
          <div
            className="item-dialog-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !deletingSearchResult) {
                setSearchDeleteTarget(null);
              }
            }}
          >
            <section
              className="search-delete-dialog card"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="search-delete-title"
              aria-describedby="search-delete-description"
              data-search-delete-dialog
            >
              <p className="eyebrow">Move to Trash</p>
              <h2 id="search-delete-title">Move “{searchDeleteTarget.title}” to Trash?</h2>
              <p id="search-delete-description">
                This {searchDeleteTarget.result_type === "conversation" ? "conversation" : searchDeleteTarget.result_type === "url" ? "link" : searchDeleteTarget.result_type} will be removed from search results. You can restore it from Trash.
              </p>
              <div className="draft-actions">
                <button
                  type="button"
                  className="text-button"
                  ref={cancelSearchDeleteRef}
                  disabled={deletingSearchResult}
                  onClick={() => setSearchDeleteTarget(null)}
                >Cancel</button>
                <button
                  type="button"
                  className="search-delete-confirm"
                  disabled={deletingSearchResult}
                  onClick={() => void moveSearchResultToTrash(searchDeleteTarget)}
                >{deletingSearchResult ? "Moving…" : "Move to Trash"}</button>
              </div>
            </section>
          </div>
        )}

        {hasSearchQuery && (
          <section className="list-panel card search-results-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Database search</p>
                <h2>Search results</h2>
              </div>
              {isSearching && <span className="empty-copy">Searching…</span>}
            </div>
            {searchError ? (
              <div className="message error" role="alert">{searchError}</div>
            ) : isSearching ? null : searchResults.length === 0 ? (
              <div className="empty-state-box"><h4>No matching results.</h4><p>Try a different search phrase.</p></div>
            ) : (
              <div className="search-result-list">
                {searchResults.map((result) => (
                  <article className="search-result" key={`${result.result_type}-${result.result_id}`}>
                    <button
                      type="button"
                      className="search-result-open"
                      onClick={() => openSearchResult(result)}
                    >
                      <span className="item-type">{result.result_type}</span>
                      <strong>{result.title}</strong>
                      <span>{(result.content || result.source_url || "").slice(0, 180)}</span>
                      <small>Created {formatDate(result.created_at)}</small>
                    </button>
                    {!result.trashed_at && (
                      <button
                        type="button"
                        className="search-result-delete"
                        aria-label={`Move ${result.result_type === "conversation" ? "conversation" : result.result_type === "url" ? "link" : result.result_type} ${result.title} to Trash`}
                        title="Move to Trash"
                        onClick={() => setSearchDeleteTarget(result)}
                      >
                        <svg aria-hidden="true" viewBox="0 0 24 24">
                          <path d="M4 7h16M10 11v6m4-6v6M5 7l1 13h12l1-13M9 7V4h6v3" />
                        </svg>
                        <span>Delete</span>
                      </button>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {activeNav === "dashboard" && !hasSearchQuery && (
          <section className="dashboard-widgets">
            <div className="welcome-panel card">
              <div>
                <p className="eyebrow">Welcome back</p>
                <h2>Turn scattered knowledge into focused answers.</h2>
              </div>
              <button type="button" className="nav-action primary" onClick={createConversation}>
                Start AI chat
              </button>
            </div>

            <div className="stats-grid">
              <button type="button" className="stat-card card" onClick={() => setActiveNav("all")}>
                <span>Total saved</span>
                <strong>{itemsLoaded ? stats.total : "…"}</strong>
              </button>
              <button type="button" className="stat-card card" onClick={() => setActiveNav("notes")}>
                <span>Notes</span>
                <strong>{itemsLoaded ? stats.notes : "…"}</strong>
              </button>
              <button type="button" className="stat-card card" onClick={() => setActiveNav("links")}>
                <span>Links</span>
                <strong>{itemsLoaded ? stats.links : "…"}</strong>
              </button>
              <button type="button" className="stat-card card" onClick={() => setActiveNav("documents")}>
                <span>Documents</span>
                <strong>{itemsLoaded ? stats.documents : "…"}</strong>
              </button>
            </div>

            <div className="content-grid">
              <div className="card panel">
                <div className="panel-header">
                  <h3>Recent items</h3>
                  <button type="button" className="text-button" onClick={() => setActiveNav("all")}>View all</button>
                </div>
                <div className="mini-list">
                  {recentItems.length === 0 ? (
                    <p className="empty-copy">No items yet. Save your first note or link.</p>
                  ) : (
                    recentItems.map((item) => (
                      <button type="button" className="mini-item" key={item.id} onClick={() => setOpenedItem(item)}>
                        <div>
                          <strong>{item.title}</strong>
                          <small>{item.source_type === "url" ? "Link" : item.source_type === "document" ? "Document" : "Note"}</small>
                        </div>
                        <span>{formatDate(item.updated_at || item.created_at)}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>

              <div className="card panel">
                <div className="panel-header">
                  <h3>Favorites</h3>
                  <button type="button" className="text-button" onClick={() => setActiveNav("favorites")}>Open</button>
                </div>
                <div className="mini-list">
                  {favoriteItems.length === 0 ? (
                    <p className="empty-copy">No favorites yet.</p>
                  ) : (
                    favoriteItems.map((item) => (
                      <button type="button" className="mini-item" key={item.id} onClick={() => setOpenedItem(item)}>
                        <div>
                          <strong>{item.title}</strong>
                          <small>{item.source_type === "url" ? item.source_url : item.content.slice(0, 26)}</small>
                        </div>
                        <span>★</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            </div>
          </section>
        )}

        {activeNav === "assistant" && !hasSearchQuery && (
          <section className="chat-layout">
            <aside className="chat-sidebar card">
              <div className="panel-header">
                <h3>Conversations</h3>
              </div>

              <div className="conversation-list">
                {visibleConversations.length === 0 ? (
                  <p className="empty-copy">No saved conversations yet.</p>
                ) : (
                  visibleConversations.map((conversation) => (
                    <button
                      key={conversation.id}
                      type="button"
                      className={`conversation-item ${conversation.id === activeConversationId ? "chosen" : ""}`}
                      onClick={() => openConversation(conversation.id)}
                    >
                      <strong>{conversation.title || "New conversation"}</strong>
                      <small>{conversation.messages?.length || 0} messages</small>
                      <small>{formatDate(conversation.updated_at)}{conversation.draft_content ? " · Draft" : ""}</small>
                    </button>
                  ))
                )}
              </div>
            </aside>

            <div className="chat-panel card">
              <div className="panel-header">
                <h3>{activeConversation?.title || "New conversation"}</h3>
                <div className="chat-actions">
                  <button type="button" className="text-button" onClick={renameConversation}>Rename</button>
                  <button type="button" className="text-button danger" onClick={deleteConversation}>Delete</button>
                </div>
              </div>

              <div className="chat-thread">
                {activeConversation?.messages && activeConversation.messages.length > 0 ? (
                  activeConversation.messages.map((message) => {
                    const displayContent = message.role === "assistant" ? cleanCitationMarkers(message.content) : message.content;
                    return (
                      <div key={message.id} className={`message-bubble ${message.role}`}>
                        <div className="bubble-header">
                          <span>{message.role === "user" ? "You" : "Assistant"}</span>
                          <small>{formatDate(message.created_at)}</small>
                          <button type="button" className="text-button" onClick={() => handleCopyContent(displayContent, message.id)}>
                            {copiedMessageId === message.id ? "Copied" : "Copy"}
                          </button>
                        </div>
                        <p>{displayContent}</p>
                        {message.role === "assistant" && message.sources?.length > 0 && (
                        <div className="message-sources">
                          <strong>Sources & Citations</strong>
                          {message.sources.map((source, sIdx) => {
                            if (["saved-link", "web-link"].includes(source.kind)) {
                              if (!isValidUrl(source.url)) return null;
                              const linkKey = source.url || `link-${sIdx}`;
                              return (
                                <a
                                  className="message-resource-link"
                                  href={source.url}
                                  key={linkKey}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  <strong>{source.title}</strong>
                                  <span>{source.description}</span>
                                  <small>
                                    {source.source || (source.kind === "saved-link" ? "Saved in Knowledge Inbox" : "Web Result")} · {source.domain}
                                    {source.relevance ? ` · ${source.relevance}` : ""}
                                  </small>
                                </a>
                              );
                            }
                            const sourceKey = source.chunkId
                              ? `${source.id}-${source.chunkId}`
                              : `${source.id}-${source.title || sIdx}`;
                            return (
                              <button
                                type="button"
                                className="citation-badge"
                                key={sourceKey}
                                onClick={() => void handleCitationClick(source)}
                                title={`Click to open saved ${source.type || "item"} #${source.id}: ${source.title}`}
                              >
                                {source.type === "url" ? "🔗 " : source.type === "document" ? "📄 " : "📝 "}
                                {source.title} · {source.type || "source"} #{source.id}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
                ) : (
                  <div className="empty-state-box">
                    <h4>Ask a question about your saved knowledge.</h4>
                    <p>Use the AI assistant to summarize notes, review links, and search your knowledge base.</p>
                  </div>
                )}
                {chatLoading && <div className="thinking">Thinking…</div>}
                <div ref={scrollAnchorRef} />
              </div>

              <form className="chat-composer" onSubmit={sendChatMessage}>
                <textarea
                  ref={chatInputRef}
                  rows="3"
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  aria-label="Message the assistant"
                  placeholder="Ask a question about your knowledge base..."
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      sendChatMessage(event);
                    }
                  }}
                />
                <div className="composer-row">
                  <div className="suggestions">
                    <button
                      type="button"
                      className="chip"
                      onClick={() => void runAssistantAction("summarize")}
                      disabled={chatLoading}
                    >
                      {assistantAction === "summarize" ? "Summarizing…" : "Summarize my notes"}
                    </button>
                    <button
                      type="button"
                      className="chip"
                      onClick={() => void runAssistantAction("links")}
                      disabled={chatLoading}
                    >
                      {assistantAction === "links" ? "Searching…" : "Find relevant links"}
                    </button>
                  </div>
                  <div className="composer-actions">
                    <label className="upload-label">
                      <input
                        type="file"
                        multiple
                        accept={documentUploadConfig.extensions.join(",")}
                        onChange={handleFileSelection}
                        disabled={uploading}
                      />
                      {uploading ? `Uploading… ${uploadProgress}%` : "Attach"}
                    </label>
                    <button type="submit" className="nav-action primary" disabled={chatLoading}>
                      {chatLoading ? "Sending…" : "Send"}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </section>
        )}

        {activeNav !== "dashboard" && activeNav !== "assistant" && !hasSearchQuery && !["drafts", "trash", "settings"].includes(activeNav) && (
          <section className="save-card card">
            <div className="panel-header">
              <h3>Add a knowledge item</h3>
            </div>

            <form onSubmit={handleSaveItem} className="save-form">
              <div className="input-group">
                <label htmlFor="item-title">Title</label>
                <input
                  id="item-title"
                  type="text"
                  value={form.title}
                  onChange={(event) => setFormValue("title", event.target.value)}
                  placeholder={
                    form.sourceType === "document"
                      ? "Give this document a title"
                      : form.sourceType === "url"
                        ? "Give this link a clear title"
                        : "Give this note a clear title"
                  }
                  required
                />
              </div>

              <div className="input-group">
                <label htmlFor="item-type">Type</label>
                <select
                  id="item-type"
                  value={form.sourceType}
                  onChange={(event) => setFormValue("sourceType", event.target.value)}
                >
                  <option value="note">Note</option>
                  <option value="url">Link</option>
                  <option value="document">Document</option>
                </select>
              </div>

              {form.sourceType === "note" && (
                <div className="input-group">
                  <label htmlFor="item-content">Content</label>
                  <textarea
                    id="item-content"
                    rows="5"
                    value={form.content}
                    onChange={(event) => setFormValue("content", event.target.value)}
                    placeholder="Write your thoughts, research notes, or useful context..."
                    required
                  />
                </div>
              )}

              {form.sourceType === "url" && (
                <>
                  <div className="input-group">
                    <label htmlFor="item-url">URL</label>
                    <input
                      id="item-url"
                      type="url"
                      value={form.sourceUrl}
                      onChange={(event) => setFormValue("sourceUrl", event.target.value)}
                      placeholder="https://example.com"
                      required
                    />
                  </div>
                  <div className="input-group">
                    <label htmlFor="item-description">Description (optional)</label>
                    <textarea
                      id="item-description"
                      rows="3"
                      value={form.description}
                      onChange={(event) => setFormValue("description", event.target.value)}
                      placeholder="Add an optional summary, notes, or key takeaways for this link..."
                    />
                  </div>
                </>
              )}

              {form.sourceType === "document" && (
                <>
                  <div className="input-group">
                    <label htmlFor="item-file">Upload Document</label>
                    <label className="upload-label" style={{ cursor: "pointer", width: "fit-content" }}>
                      <input
                        id="item-file"
                        type="file"
                        accept={documentUploadConfig.extensions.join(",")}
                        onChange={handleDocumentFileSelect}
                        disabled={saving}
                      />
                      <span>{form.file ? "Change file" : "Choose file"}</span>
                    </label>
                    {form.file && (
                      <div className="selected-file-info" style={{ marginTop: "6px", color: "#a78bfa", fontSize: "0.9rem" }}>
                        📄 Selected: <strong>{form.file.name}</strong> ({Math.round(form.file.size / 1024)} KB)
                      </div>
                    )}
                    {saving && (
                      <div style={{ marginTop: "8px" }}>
                        <progress className="upload-progress" value={uploadProgress} max="100" aria-label="Upload progress">
                          {uploadProgress}%
                        </progress>
                        <small style={{ color: "#94a3b8" }}>Uploading & processing… {uploadProgress}%</small>
                      </div>
                    )}
                    <small style={{ color: "#94a3b8", marginTop: "4px" }}>
                      Supported: PDF, DOC/DOCX, TXT/Markdown, CSV, XLS/XLSX, JSON/XML, PPT/PPTX, PNG/JPG/WEBP, MP3/WAV/M4A, MP4/WEBM, ZIP (up to {Math.floor(documentUploadConfig.maxFileSize / (1024 * 1024))} MB).
                    </small>
                  </div>
                  <div className="input-group">
                    <label htmlFor="item-doc-notes">Description or Notes (optional)</label>
                    <textarea
                      id="item-doc-notes"
                      rows="4"
                      value={form.description}
                      onChange={(event) => setFormValue("description", event.target.value)}
                      placeholder="Add your own notes, summary, or commentary for this document..."
                    />
                  </div>
                </>
              )}

              <button type="submit" className="nav-action primary" disabled={saving}>
                {saving ? (form.sourceType === "document" ? `Saving (${uploadProgress}%)…` : "Saving...") : "Save item"}
              </button>
            </form>
          </section>
        )}

        {activeNav !== "dashboard" && activeNav !== "assistant" && !hasSearchQuery && (
          <section className="list-panel card">
            <div className="panel-header with-controls">
              <div>
                <p className="eyebrow">Saved items</p>
                <h2>
                  {activeNav === "all" && "All items"}
                  {activeNav === "notes" && "Notes"}
                  {activeNav === "links" && "Links"}
                  {activeNav === "favorites" && "Favorites"}
                  {activeNav === "recent" && "Recent items"}
                  {activeNav === "drafts" && "Drafts"}
                  {activeNav === "trash" && "Trash"}
                  {activeNav === "documents" && "Documents"}
                  {activeNav === "settings" && "Settings"}
                </h2>
              </div>
              {activeNav !== "settings" && (
                <button type="button" className="text-button" onClick={() => setActiveNav("dashboard")}>Back to dashboard</button>
              )}
            </div>

            {activeNav === "drafts" ? (
              <div className="draft-list">
                {drafts.length === 0 ? (
                  <div className="empty-state-box"><h4>No drafts yet.</h4><p>Unfinished notes and links are saved here automatically.</p></div>
                ) : drafts.map((draft) => (
                  <article className="draft-row" key={draft.id}>
                    <div>
                      <strong>{draft.title || "Untitled draft"}</strong>
                      <p>{draft.source_type === "url" ? draft.source_url : draft.content}</p>
                      <small>Created {formatDate(draft.created_at)} · Updated {formatDate(draft.updated_at)}</small>
                    </div>
                    <div className="draft-actions">
                      <button type="button" className="text-button" onClick={() => {
                        setDraftId(draft.id);
                        setForm({ title: draft.title, content: draft.content, sourceType: draft.source_type, sourceUrl: draft.source_url || "" });
                        setActiveNav(draft.source_type === "url" ? "links" : "notes");
                      }}>Reopen</button>
                      <button type="button" className="text-button danger" onClick={async () => {
                        const response = await fetch(`${API_BASE}/drafts/${draft.id}`, { method: "DELETE" });
                        if (!response.ok) setErrorMessage("Could not delete draft.");
                        else setDrafts((current) => current.filter((entry) => entry.id !== draft.id));
                      }}>Delete</button>
                    </div>
                  </article>
                ))}
              </div>
            ) : activeNav === "trash" ? (
              <div className="draft-list">
                {trashItems.length === 0 && trashConversations.length === 0 ? (
                  <div className="empty-state-box"><h4>Trash is empty.</h4><p>Deleted saved items can be restored here.</p></div>
                ) : trashItems.map((item) => (
                  <article className="draft-row" key={item.id}>
                    <div>
                      <button type="button" className="text-button" onClick={() => setOpenedItem(item)}>
                        <strong>{item.title}</strong>
                      </button>
                      <p>{item.content.slice(0, 240)}</p>
                      <small>{item.source_type === "url" ? "Link" : item.source_type === "document" ? "Document" : "Note"} · Created {formatDate(item.created_at)} · Deleted {formatDate(item.trashed_at)}</small>
                    </div>
                    <div className="draft-actions">
                      <button type="button" className="text-button" onClick={() => restoreItem(item)}>Restore</button>
                      <button type="button" className="text-button danger" onClick={() => permanentlyDeleteItem(item)}>Delete permanently</button>
                    </div>
                  </article>
                )).concat(trashConversations.map((conversation) => (
                  <article className="draft-row" key={`chat-${conversation.id}`}>
                    <div>
                      <button type="button" className="text-button" onClick={() => setOpenedItem({
                        ...conversation,
                        source_type: "conversation",
                        content: "Saved conversation",
                      })}>
                        <strong>{conversation.title}</strong>
                      </button>
                      <p>Conversation</p>
                      <small>Created {formatDate(conversation.created_at)} · Deleted {formatDate(conversation.trashed_at)}</small>
                    </div>
                    <div className="draft-actions">
                      <button type="button" className="text-button" onClick={() => restoreConversation(conversation)}>Restore</button>
                      <button type="button" className="text-button danger" onClick={() => permanentlyDeleteConversation(conversation)}>Delete permanently</button>
                    </div>
                  </article>
                )))}
              </div>
            ) : activeNav === "settings" ? (
              <div className="settings-box">
                <h4>Configuration</h4>
                <p>
                  Gemini configuration: {geminiStatus === "checking"
                    ? "Checking backend…"
                    : geminiStatus === "configured"
                      ? "A key is configured on the backend (validity is checked when you send a message)."
                      : geminiStatus === "missing"
                        ? "No key is configured. Add GEMINI_API_KEY to backend/.env; .env.example is only a template."
                        : "Could not check the backend configuration."}
                </p>
                <p>Set GEMINI_MODEL in backend/.env to a model available to your API key.</p>
                <p>Google Drive access is disabled until Google OAuth credentials are configured.</p>
              </div>
            ) : (
              <div className="item-grid">
                {visibleItems.length === 0 ? (
                  <div className="empty-state-box">
                    <h4>No items match this view.</h4>
                    <p>Save a note, link, or document to populate your knowledge base.</p>
                  </div>
                ) : (
                  visibleItems.map(renderItemCard)
                )}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

export default App;