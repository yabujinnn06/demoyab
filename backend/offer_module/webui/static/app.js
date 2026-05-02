document.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("has-motion");

  const playResultSound = () => {
    const soundUrl = document.body.dataset.resultSoundUrl;
    const soundKey = document.body.dataset.resultSoundKey;
    if (!soundUrl || !soundKey) {
      return;
    }

    const storageKey = `rainwater-result-sound:${soundKey}`;
    try {
      if (window.sessionStorage.getItem(storageKey) === "played") {
        return;
      }
    } catch (_error) {
      // Continue without persistence if storage is blocked.
    }

    const audio = new Audio(soundUrl);
    audio.preload = "auto";
    audio.volume = 0.75;

    const markPlayed = () => {
      try {
        window.sessionStorage.setItem(storageKey, "played");
      } catch (_error) {
        // Ignore storage failures.
      }
    };

    const play = () => audio.play().then(markPlayed);
    play().catch(() => {
      const playAfterGesture = () => {
        cleanup();
        audio.currentTime = 0;
        play().catch(() => {});
      };
      const cleanup = () => {
        window.removeEventListener("pointerdown", playAfterGesture, true);
        window.removeEventListener("keydown", playAfterGesture, true);
      };
      window.addEventListener("pointerdown", playAfterGesture, { once: true, capture: true });
      window.addEventListener("keydown", playAfterGesture, { once: true, capture: true });
    });
  };

  playResultSound();

  const initActivityLogTable = () => {
    const root = document.querySelector("[data-activity-log]");
    if (!root) {
      return;
    }

    const rows = Array.from(root.querySelectorAll("[data-activity-row]"));
    const searchInput = root.querySelector("[data-activity-search]");
    const actionFilter = root.querySelector("[data-activity-filter]");
    const previousButton = root.querySelector("[data-activity-prev]");
    const nextButton = root.querySelector("[data-activity-next]");
    const pageLabel = root.querySelector("[data-activity-page-label]");
    const noResultsRow = root.querySelector("[data-activity-no-results]");
    const tableWrap = root.querySelector(".activity-log-table-wrap");
    const pageSize = 10;
    let currentPage = 1;

    const filteredRows = () => {
      const query = (searchInput?.value || "").trim().toLowerCase();
      const action = actionFilter?.value || "";
      return rows.filter((row) => {
        const matchesAction = !action || row.dataset.action === action;
        const matchesQuery = !query || (row.dataset.search || "").includes(query);
        return matchesAction && matchesQuery;
      });
    };

    const render = () => {
      const visibleRows = filteredRows();
      const pageCount = Math.max(1, Math.ceil(visibleRows.length / pageSize));
      currentPage = Math.min(currentPage, pageCount);
      const start = (currentPage - 1) * pageSize;
      const end = start + pageSize;

      rows.forEach((row) => {
        row.hidden = true;
      });
      visibleRows.slice(start, end).forEach((row) => {
        row.hidden = false;
      });
      if (noResultsRow) {
        noResultsRow.hidden = rows.length === 0 || visibleRows.length > 0;
      }

      if (pageLabel) {
        pageLabel.textContent = visibleRows.length === 0
          ? "Kayıt yok"
          : `Sayfa ${currentPage} / ${pageCount} · ${visibleRows.length} kayıt`;
      }
      if (previousButton) {
        previousButton.disabled = currentPage <= 1;
      }
      if (nextButton) {
        nextButton.disabled = currentPage >= pageCount;
      }
    };

    searchInput?.addEventListener("input", () => {
      currentPage = 1;
      if (tableWrap) {
        tableWrap.scrollLeft = 0;
      }
      render();
    });
    actionFilter?.addEventListener("change", () => {
      currentPage = 1;
      if (tableWrap) {
        tableWrap.scrollLeft = 0;
      }
      render();
    });
    previousButton?.addEventListener("click", () => {
      currentPage = Math.max(1, currentPage - 1);
      render();
    });
    nextButton?.addEventListener("click", () => {
      currentPage += 1;
      render();
    });
    render();
  };

  initActivityLogTable();

  const initBatchFileInput = () => {
    const input = document.querySelector("[data-batch-file-input]");
    if (!input || typeof DataTransfer === "undefined") {
      return;
    }

    const panel = document.querySelector("[data-batch-file-panel]");
    const list = document.querySelector("[data-batch-file-list]");
    const countLabel = document.querySelector("[data-batch-file-count]");
    const clearButton = document.querySelector("[data-batch-file-clear]");
    let selectedFiles = [];

    const fileKey = (file) => `${file.name}:${file.size}:${file.lastModified}`;

    const syncInputFiles = () => {
      const transfer = new DataTransfer();
      selectedFiles.forEach((file) => transfer.items.add(file));
      input.files = transfer.files;
    };

    const render = () => {
      input.dataset.batchFileNames = JSON.stringify(selectedFiles.map((file) => file.name));
      if (panel) {
        panel.hidden = selectedFiles.length === 0;
      }
      if (countLabel) {
        countLabel.textContent = `${selectedFiles.length} PDF seçildi`;
      }
      if (!list) {
        return;
      }
      list.innerHTML = "";
      selectedFiles.forEach((file, index) => {
        const row = document.createElement("div");
        row.className = "batch-file-row";

        const name = document.createElement("span");
        name.textContent = file.name;

        const button = document.createElement("button");
        button.className = "btn btn-sm btn-outline-danger";
        button.type = "button";
        button.textContent = "Sil";
        button.addEventListener("click", () => {
          selectedFiles.splice(index, 1);
          syncInputFiles();
          render();
        });

        row.append(name, button);
        list.append(row);
      });
      document.dispatchEvent(new CustomEvent("batch-files-changed"));
    };

    input.addEventListener("change", () => {
      const seen = new Set(selectedFiles.map(fileKey));
      Array.from(input.files || []).forEach((file) => {
        if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
          return;
        }
        const key = fileKey(file);
        if (!seen.has(key)) {
          seen.add(key);
          selectedFiles.push(file);
        }
      });
      syncInputFiles();
      render();
    });

    clearButton?.addEventListener("click", () => {
      selectedFiles = [];
      syncInputFiles();
      render();
    });
  };

  initBatchFileInput();

  const initBatchSelectionBoard = () => {
    const board = document.querySelector("[data-batch-selection-board]");
    if (!board) {
      return;
    }

    const searchInput = board.querySelector("[data-batch-offer-search]");
    const offerOptions = Array.from(board.querySelectorAll("[data-batch-offer-option]"));
    const offerCheckboxes = Array.from(board.querySelectorAll("[data-batch-offer-checkbox]"));
    const selectVisibleButton = board.querySelector("[data-batch-select-visible]");
    const clearOffersButton = board.querySelector("[data-batch-clear-offers]");
    const registeredCount = board.querySelector("[data-batch-registered-count]");
    const totalCount = board.querySelector("[data-batch-total-count]");
    const selectionList = board.querySelector("[data-batch-selection-list]");
    const fileInput = board.querySelector("[data-batch-file-input]");

    const uploadedFileNames = () => {
      try {
        return JSON.parse(fileInput?.dataset.batchFileNames || "[]");
      } catch (_error) {
        return [];
      }
    };

    const renderBasket = () => {
      const selectedOffers = offerCheckboxes
        .filter((checkbox) => checkbox.checked)
        .map((checkbox) => checkbox.value);
      const uploaded = uploadedFileNames();
      const total = selectedOffers.length + uploaded.length;

      if (registeredCount) {
        registeredCount.textContent = `${selectedOffers.length} seçili`;
      }
      if (totalCount) {
        totalCount.textContent = `${total} PDF`;
      }
      if (!selectionList) {
        return;
      }

      selectionList.innerHTML = "";
      if (total === 0) {
        const empty = document.createElement("p");
        empty.className = "helper-text mb-0";
        empty.textContent = "Henüz PDF seçilmedi.";
        selectionList.append(empty);
        return;
      }

      [...selectedOffers, ...uploaded].forEach((name) => {
        const row = document.createElement("div");
        row.className = "batch-selection-item";
        const label = document.createElement("span");
        label.textContent = name;
        row.append(label);
        selectionList.append(row);
      });
    };

    const applySearch = () => {
      const query = (searchInput?.value || "").trim().toLowerCase();
      offerOptions.forEach((option) => {
        const matches = !query || (option.dataset.search || "").includes(query);
        option.hidden = !matches;
      });
    };

    searchInput?.addEventListener("input", applySearch);
    offerCheckboxes.forEach((checkbox) => checkbox.addEventListener("change", renderBasket));
    selectVisibleButton?.addEventListener("click", () => {
      offerOptions.forEach((option) => {
        if (!option.hidden) {
          const checkbox = option.querySelector("[data-batch-offer-checkbox]");
          if (checkbox) {
            checkbox.checked = true;
          }
        }
      });
      renderBasket();
    });
    clearOffersButton?.addEventListener("click", () => {
      offerCheckboxes.forEach((checkbox) => {
        checkbox.checked = false;
      });
      renderBasket();
    });
    document.addEventListener("batch-files-changed", renderBasket);

    applySearch();
    renderBasket();
  };

  initBatchSelectionBoard();

  const initBatchResultFilters = () => {
    const rows = Array.from(document.querySelectorAll("[data-batch-row]"));
    const buttons = Array.from(document.querySelectorAll("[data-batch-filter]"));
    const countLabel = document.querySelector("[data-batch-filter-count]");
    if (!rows.length || !buttons.length) {
      return;
    }

    const applyFilter = (filter) => {
      let visibleCount = 0;
      rows.forEach((row) => {
        const visible = filter === "all" || row.dataset.batchCategory === filter;
        row.hidden = !visible;
        if (visible) {
          visibleCount += 1;
        }
      });
      buttons.forEach((button) => {
        button.classList.toggle("active", button.dataset.batchFilter === filter);
      });
      if (countLabel) {
        countLabel.textContent = `${visibleCount} teklif`;
      }
    };

    buttons.forEach((button) => {
      button.addEventListener("click", () => applyFilter(button.dataset.batchFilter || "all"));
    });
    applyFilter("all");
  };

  initBatchResultFilters();

  const renumberCreateItems = (container) => {
    const rows = Array.from(container.querySelectorAll(".create-item-row"));
    rows.forEach((row, index) => {
      const badge = row.querySelector(".result-order");
      if (badge) {
        badge.textContent = `Kalem ${index + 1}`;
      }
    });
  };

  const addRowButtons = Array.from(document.querySelectorAll("[data-add-item-row]"));

  addRowButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const form = button.closest("form");
      const container = form?.querySelector("[data-item-rows]");
      const templateRow = container?.querySelector(".create-item-row:last-child");
      if (!container || !templateRow) {
        return;
      }

      const clone = templateRow.cloneNode(true);
      clone.querySelectorAll("input").forEach((input) => {
        input.value = input.name === "quantities" ? "1" : "";
      });
      clone.querySelectorAll("select").forEach((select) => {
        if (select.name === "discount_types") {
          select.value = "none";
          return;
        }
        select.selectedIndex = 0;
      });
      container.appendChild(clone);
      renumberCreateItems(container);
    });
  });

  document.querySelectorAll("[data-item-rows]").forEach((container) => {
    renumberCreateItems(container);
  });

  const workspaceLinks = Array.from(document.querySelectorAll("[data-workspace-link]"));
  const workspaceHeading = document.querySelector("[data-workspace-heading]");
  const workspaceSummary = document.querySelector("[data-workspace-summary]");
  const workspaceBadge = document.querySelector("[data-workspace-badge]");
  const workspaceCurrentLabels = Array.from(document.querySelectorAll("[data-workspace-current]"));
  const workspaceDrawer = document.getElementById("workspaceDrawer");
  const workspaceStorageKey = "rainwater-active-workspace";

  const syncWorkspaceChrome = (workspaceName) => {
    const primaryLink = workspaceLinks.find(
      (link) => link.dataset.workspaceTarget === workspaceName && !link.disabled,
    );
    if (!primaryLink) {
      return;
    }

    workspaceLinks.forEach((link) => {
      const isActive = link.dataset.workspaceTarget === workspaceName;
      link.classList.toggle("active", isActive);
      link.setAttribute("aria-selected", isActive ? "true" : "false");
    });

    if (workspaceHeading) {
      workspaceHeading.textContent = primaryLink.dataset.workspaceTitle || "";
    }
    if (workspaceSummary) {
      workspaceSummary.textContent = primaryLink.dataset.workspaceSummary || "";
    }
    if (workspaceBadge) {
      workspaceBadge.textContent = primaryLink.dataset.workspaceBadge || "";
    }
    workspaceCurrentLabels.forEach((label) => {
      label.textContent = primaryLink.dataset.workspaceTitle || "";
    });

    try {
      window.localStorage.setItem(workspaceStorageKey, workspaceName);
    } catch (_error) {
      // Ignore storage failures.
    }
  };

  const showWorkspace = (workspaceName) => {
    const targetLink = workspaceLinks.find(
      (link) => link.dataset.workspaceTarget === workspaceName && !link.disabled,
    );
    if (!targetLink) {
      return;
    }

    if (window.bootstrap?.Tab) {
      window.bootstrap.Tab.getOrCreateInstance(targetLink).show();
      return;
    }

    document.querySelectorAll(".workspace-pane-stack > .tab-pane").forEach((pane) => {
      pane.classList.remove("show", "active");
    });
    const pane = document.getElementById(`workspace-pane-${workspaceName}`);
    pane?.classList.add("show", "active");
    syncWorkspaceChrome(workspaceName);
  };

  workspaceLinks.forEach((link) => {
    link.addEventListener("shown.bs.tab", (event) => {
      const workspaceName = event.target.dataset.workspaceTarget;
      syncWorkspaceChrome(workspaceName);
      const drawerInstance = workspaceDrawer && window.bootstrap?.Offcanvas
        ? window.bootstrap.Offcanvas.getInstance(workspaceDrawer)
        : null;
      drawerInstance?.hide();
    });
  });

  document.querySelectorAll("[data-open-workspace]").forEach((button) => {
    button.addEventListener("click", () => {
      showWorkspace(button.dataset.openWorkspace);
      const focusIndex = button.dataset.focusDecision;
      if (focusIndex === undefined) {
        return;
      }
      window.setTimeout(() => {
        const targetCard = document.getElementById(`decision-row-${focusIndex}`);
        if (!targetCard) {
          return;
        }
        targetCard.scrollIntoView({ behavior: "smooth", block: "center" });
        targetCard.classList.add("decision-card-focus");
        window.setTimeout(() => targetCard.classList.remove("decision-card-focus"), 1800);
      }, 220);
    });
  });

  const applyCheckboxes = Array.from(document.querySelectorAll("[data-apply-checkbox]"));
  const selectedCountLabels = Array.from(document.querySelectorAll("[data-selected-count]"));
  const waitingCountLabels = Array.from(document.querySelectorAll("[data-waiting-count]"));
  const ignoredCountLabels = Array.from(document.querySelectorAll("[data-ignored-count]"));
  const applySubmitButtons = Array.from(document.querySelectorAll("[data-apply-submit]"));
  const decisionCards = Array.from(document.querySelectorAll("[data-decision-card]"));
  const decisionSearchInput = document.querySelector("[data-decision-search]");
  const decisionFilterButtons = Array.from(document.querySelectorAll("[data-decision-filter]"));
  const decisionFilterCount = document.querySelector("[data-decision-filter-count]");
  let activeDecisionFilter = "all";

  const getDecisionState = () => {
    const selectedCards = decisionCards.filter((card) => {
      const checkbox = card.querySelector("[data-apply-checkbox]");
      return checkbox?.checked && !checkbox.disabled;
    });
    const waitingCards = decisionCards.filter((card) => {
      const select = card.querySelector("[data-manual-match]");
      const checkbox = card.querySelector("[data-apply-checkbox]");
      const ignore = card.querySelector("[data-ignore-row]");
      return card.dataset.decisionStatus !== "ONAY" && !ignore?.checked && checkbox?.disabled && select && !select.value;
    });
    const approvedCards = decisionCards.filter((card) => card.dataset.decisionStatus === "ONAY");
    const ignoredCards = decisionCards.filter((card) => card.querySelector("[data-ignore-row]")?.checked);
    return { selectedCards, waitingCards, approvedCards, ignoredCards };
  };

  const cardMatchesDecisionFilter = (card, filterName) => {
    const checkbox = card.querySelector("[data-apply-checkbox]");
    const ignore = card.querySelector("[data-ignore-row]");
    const select = card.querySelector("[data-manual-match]");
    if (filterName === "selected") {
      return Boolean(checkbox?.checked && !checkbox.disabled);
    }
    if (filterName === "waiting") {
      return card.dataset.decisionStatus !== "ONAY" && !ignore?.checked && checkbox?.disabled && select && !select.value;
    }
    if (filterName === "ignored") {
      return Boolean(ignore?.checked);
    }
    if (filterName === "approved") {
      return card.dataset.decisionStatus === "ONAY";
    }
    return true;
  };

  const renderDecisionFilters = () => {
    const query = (decisionSearchInput?.value || "").trim().toLocaleLowerCase("tr-TR");
    let visibleCount = 0;
    decisionCards.forEach((card) => {
      const textMatch = !query || card.textContent.toLocaleLowerCase("tr-TR").includes(query);
      const filterMatch = cardMatchesDecisionFilter(card, activeDecisionFilter);
      const visible = textMatch && filterMatch;
      card.hidden = !visible;
      if (visible) {
        visibleCount += 1;
      }
    });
    decisionFilterButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.decisionFilter === activeDecisionFilter);
    });
    if (decisionFilterCount) {
      decisionFilterCount.textContent = `${visibleCount} satır`;
    }
  };

  const focusDecisionCard = (card) => {
    if (!card) {
      return;
    }
    showWorkspace("apply");
    window.setTimeout(() => {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.add("decision-card-focus");
      window.setTimeout(() => card.classList.remove("decision-card-focus"), 1800);
    }, 220);
  };

  const focusDecisionCardByIndex = (index) => {
    if (index === undefined || index === null || index === "") {
      return;
    }
    focusDecisionCard(document.getElementById(`decision-row-${index}`));
  };

  document.querySelectorAll("[data-result-card]").forEach((card) => {
    const openDecision = () => focusDecisionCardByIndex(card.dataset.reviewIndex);
    card.addEventListener("click", (event) => {
      if (event.target.closest("a, button, input, select, textarea, label")) {
        return;
      }
      openDecision();
    });
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      openDecision();
    });
  });

  const updateCorrectionSelectionState = () => {
    const { selectedCards, waitingCards, ignoredCards } = getDecisionState();
    const selectedCount = selectedCards.length;
    selectedCountLabels.forEach((label) => {
      label.textContent = String(selectedCount);
    });
    waitingCountLabels.forEach((label) => {
      label.textContent = `${waitingCards.length} satır`;
    });
    ignoredCountLabels.forEach((label) => {
      label.textContent = String(ignoredCards.length);
    });
    applySubmitButtons.forEach((button) => {
      button.disabled = selectedCount === 0;
      button.textContent = selectedCount === 0
        ? "Önce düzeltilecek satır seç"
        : `Seçili düzeltmeleri hazırla (${selectedCount})`;
    });
    renderDecisionFilters();
  };

  applyCheckboxes.forEach((checkbox) => {
    checkbox.addEventListener("change", updateCorrectionSelectionState);
  });

  const updateManualMatchCard = (select) => {
    const decisionCard = select.closest(".decision-card");
    const checkbox = decisionCard?.querySelector("[data-apply-checkbox]");
    const label = decisionCard?.querySelector("[data-apply-label]");
    const preview = decisionCard?.querySelector("[data-manual-preview]");
    const previewLabel = decisionCard?.querySelector("[data-manual-preview-label]");
    if (checkbox) {
      const canApplyWithoutManual = checkbox.dataset.canApply === "true";
      if (select.value) {
        checkbox.disabled = false;
        checkbox.checked = true;
        if (label) {
          label.textContent = "Manuel seçimle düzenlenecek";
        }
      } else if (!canApplyWithoutManual) {
        checkbox.checked = false;
        checkbox.disabled = true;
        if (label) {
          label.textContent = "Ürün seçince aktif olur";
        }
      }
    }
    if (preview && previewLabel) {
      const selectedOption = select.selectedOptions?.[0];
      const selectedText = selectedOption && select.value ? selectedOption.textContent.trim() : "";
      preview.hidden = !selectedText;
      previewLabel.textContent = selectedText;
    }
    updateCorrectionSelectionState();
  };

  document.querySelectorAll("[data-manual-match]").forEach((select) => {
    select.addEventListener("change", () => updateManualMatchCard(select));
    updateManualMatchCard(select);
  });

  document.querySelectorAll("[data-bundle-match]").forEach((select) => {
    select.addEventListener("change", () => {
      const decisionCard = select.closest(".decision-card");
      const checkbox = decisionCard?.querySelector("[data-apply-checkbox]");
      const label = decisionCard?.querySelector("[data-apply-label]");
      if (checkbox) {
        checkbox.disabled = false;
        checkbox.checked = true;
      }
      if (label) {
        label.textContent = "Bileşen seçimiyle düzenlenecek";
      }
      updateCorrectionSelectionState();
    });
  });

  document.querySelectorAll("[data-ignore-row]").forEach((ignore) => {
    ignore.addEventListener("change", () => {
      const decisionCard = ignore.closest(".decision-card");
      const checkbox = decisionCard?.querySelector("[data-apply-checkbox]");
      const label = decisionCard?.querySelector("[data-apply-label]");
      const manualSelect = decisionCard?.querySelector("[data-manual-match]");
      const bundleSelects = Array.from(decisionCard?.querySelectorAll("[data-bundle-match]") || []);
      if (ignore.checked) {
        if (checkbox) {
          checkbox.checked = false;
          checkbox.disabled = true;
        }
        if (label) {
          label.textContent = "PDF düzeltmesinde atlanacak";
        }
        if (manualSelect) {
          manualSelect.value = "";
          manualSelect.disabled = true;
        }
        bundleSelects.forEach((select) => {
          select.disabled = true;
        });
        decisionCard?.classList.add("is-ignored");
      } else {
        if (label) {
          label.textContent = "Ürün seçince aktif olur";
        }
        if (manualSelect) {
          manualSelect.disabled = false;
        }
        bundleSelects.forEach((select) => {
          select.disabled = false;
        });
        decisionCard?.classList.remove("is-ignored");
      }
      updateCorrectionSelectionState();
    });
  });

  document.querySelectorAll("[data-suggestion-pick]").forEach((button) => {
    button.addEventListener("click", () => {
      const select = document.getElementById(button.dataset.targetSelect);
      if (!select) {
        return;
      }
      select.value = button.dataset.suggestionValue || "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      button.closest(".decision-card")?.classList.add("decision-card-focus");
      window.setTimeout(() => button.closest(".decision-card")?.classList.remove("decision-card-focus"), 1200);
    });
  });

  document.querySelectorAll("[data-queue-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const { selectedCards, waitingCards, approvedCards } = getDecisionState();
      const targetType = button.dataset.queueTarget;
      const targetCard = targetType === "waiting"
        ? waitingCards[0]
        : targetType === "approved"
          ? approvedCards[0]
          : selectedCards[0];
      focusDecisionCard(targetCard);
    });
  });

  const initAiNarration = () => {
    const panels = Array.from(document.querySelectorAll("[data-ai-narration]"));
    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    let cachedTurkishVoice = null;

    const voiceName = (voice) => `${voice.name || ""} ${voice.voiceURI || ""}`.toLowerCase();
    const premiumFemaleVoiceNames = [
      "tr-tr-emelneural",
      "microsoft emel online",
      "microsoft emel",
      "emel",
      "seda",
      "selin",
      "ipek",
      "filiz",
      "yelda",
      "sibel",
      "nova",
      "shimmer",
      "ava",
      "emma",
    ];
    const maleVoiceNames = ["ahmet", "tolga", "male", "erkek"];
    const isGoogleVoice = (voice) => voiceName(voice).includes("google");
    const isLikelyFemaleVoice = (voice) => {
      const name = voiceName(voice);
      return premiumFemaleVoiceNames.some((candidate) => name.includes(candidate));
    };
    const isLikelyMaleVoice = (voice) => {
      const name = voiceName(voice);
      return maleVoiceNames.some((candidate) => name.includes(candidate));
    };
    const isTurkishVoice = (voice) => {
      const name = voiceName(voice);
      const lang = (voice.lang || "").toLowerCase();
      return lang.startsWith("tr") || name.includes("turkish") || name.includes("türk") || name.includes("turk");
    };

    const voiceScore = (voice) => {
      if (isGoogleVoice(voice)) return -999;
      const name = `${voice.name || ""} ${voice.voiceURI || ""}`.toLowerCase();
      const lang = (voice.lang || "").toLowerCase();
      let score = 0;
      if (lang === "tr-tr") score += 100;
      if (lang.startsWith("tr")) score += 80;
      if (name.includes("turkish") || name.includes("türk") || name.includes("turk")) score += 40;
      if (name.includes("tr-tr-emelneural")) score += 140;
      if (name.includes("emel")) score += 120;
      if (isLikelyFemaleVoice(voice)) score += 70;
      if (name.includes("microsoft")) score += 48;
      if (name.includes("online")) score += 38;
      if (name.includes("natural") || name.includes("neural")) score += 34;
      if (isLikelyMaleVoice(voice)) score -= 220;
      if (!voice.localService) score += 6;
      return score;
    };

    const loadVoices = () => new Promise((resolve) => {
      if (!("speechSynthesis" in window)) {
        resolve([]);
        return;
      }
      const voices = window.speechSynthesis.getVoices();
      if (voices.length) {
        resolve(voices);
        return;
      }
      const handleVoices = () => {
        window.speechSynthesis.removeEventListener("voiceschanged", handleVoices);
        resolve(window.speechSynthesis.getVoices());
      };
      window.speechSynthesis.addEventListener("voiceschanged", handleVoices);
      window.setTimeout(() => {
        window.speechSynthesis.removeEventListener("voiceschanged", handleVoices);
        resolve(window.speechSynthesis.getVoices());
      }, 1200);
    });

    const bestTurkishVoice = async () => {
      if (cachedTurkishVoice) {
        return cachedTurkishVoice;
      }
      const voices = await loadVoices();
      const preferredVoices = voices
        .filter((voice) => isTurkishVoice(voice) && !isGoogleVoice(voice))
        .sort((left, right) => voiceScore(right) - voiceScore(left));
      cachedTurkishVoice = preferredVoices.find((voice) => isLikelyFemaleVoice(voice) && !isLikelyMaleVoice(voice))
        || preferredVoices.find((voice) => !isLikelyMaleVoice(voice))
        || null;
      return cachedTurkishVoice;
    };

    const typeText = (target, text) => {
      if (!target || prefersReducedMotion) {
        if (target) {
          target.textContent = text;
        }
        return;
      }
      target.classList.add("is-typing");
      target.textContent = "";
      let index = 0;
      const tick = () => {
        target.textContent = text.slice(0, index);
        index += 1;
        if (index <= text.length) {
          window.setTimeout(tick, 14);
          return;
        }
        target.classList.remove("is-typing");
      };
      tick();
    };

    panels.forEach((panel) => {
      const button = panel.querySelector("[data-ai-speak]");
      const target = panel.querySelector("[data-ai-type-line]");
      const text = panel.dataset.aiText || target?.textContent || "";
      button?.addEventListener("click", async () => {
        const originalLabel = button.textContent;
        typeText(target, text);
        if (!("speechSynthesis" in window) || !text.trim()) {
          return;
        }
        window.speechSynthesis.cancel();
        const voice = await bestTurkishVoice();
        if (!voice) {
          button.textContent = "Kurumsal kadın Türkçe sesi bulunamadı";
          button.disabled = true;
          window.setTimeout(() => {
            button.textContent = originalLabel;
            button.disabled = false;
          }, 1800);
          return;
        }
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.voice = voice;
        utterance.lang = "tr-TR";
        utterance.rate = 0.88;
        utterance.pitch = 1.06;
        utterance.volume = 1;
        button.textContent = "Emel kurumsal sesle okunuyor";
        button.disabled = true;
        utterance.onend = () => {
          button.textContent = originalLabel;
          button.disabled = false;
        };
        utterance.onerror = () => {
          button.textContent = originalLabel;
          button.disabled = false;
        };
        window.speechSynthesis.speak(utterance);
      });
    });
  };

  const initResultReveal = () => {
    const cards = Array.from(document.querySelectorAll("[data-result-card], [data-decision-card], .finance-review-card"));
    if (!cards.length) {
      return;
    }
    if (!("IntersectionObserver" in window)) {
      cards.forEach((card) => card.classList.add("is-visible"));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.12 });
    cards.forEach((card, index) => {
      card.style.animationDelay = `${Math.min(index, 8) * 45}ms`;
      observer.observe(card);
    });
  };

  const initQuoteBuilderSummary = () => {
    const createPane = document.querySelector("#workspace-pane-create");
    const form = createPane?.querySelector("form.vstack");
    if (!form || form.querySelector("[data-quote-builder-summary]")) {
      return;
    }

    const summary = document.createElement("aside");
    summary.className = "quote-builder-summary";
    summary.dataset.quoteBuilderSummary = "true";
    summary.innerHTML = `
      <div class="quote-summary-head">
        <span class="section-kicker">Canlı özet</span>
        <strong>Teklif özeti</strong>
        <small>Bu panel sadece mevcut form alanlarından hesaplanır; kayıt akışını değiştirmez.</small>
      </div>
      <div class="quote-summary-grid">
        <article><span>Kalem</span><strong data-quote-count>0</strong></article>
        <article><span>Ara toplam</span><strong data-quote-subtotal>-</strong></article>
        <article><span>İskonto</span><strong data-quote-discount>-</strong></article>
        <article><span>Net toplam</span><strong data-quote-total>-</strong></article>
      </div>
      <div class="quote-summary-meta">
        <div><span>Firma</span><strong data-quote-company>-</strong></div>
        <div><span>Geçerlilik</span><strong data-quote-validity>-</strong></div>
        <div><span>Teklif no</span><strong data-quote-number>-</strong></div>
      </div>
    `;

    const submitRow = form.querySelector(".d-flex.flex-column.flex-lg-row.align-items-lg-center.gap-3");
    form.insertBefore(summary, submitRow || null);

    const parseMoney = (value) => {
      const normalized = String(value || "")
        .replace(/\s/g, "")
        .replace(/\./g, "")
        .replace(",", ".")
        .replace(/[^\d.-]/g, "");
      const parsed = Number.parseFloat(normalized);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const formatMoney = (value) =>
      value > 0
        ? new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY", maximumFractionDigits: 0 }).format(value)
        : "-";

    const renderSummary = () => {
      const rows = Array.from(form.querySelectorAll(".create-item-row"));
      let subtotal = 0;
      let discount = 0;

      rows.forEach((row) => {
        const quantity = parseMoney(row.querySelector("[name='quantities']")?.value) || 1;
        const manualPrice = parseMoney(row.querySelector("[name='manual_prices']")?.value);
        const discountValue = parseMoney(row.querySelector("[name='discount_values']")?.value);
        const discountType = row.querySelector("[name='discount_types']")?.value || "none";
        const lineSubtotal = Math.max(0, quantity * manualPrice);
        subtotal += lineSubtotal;
        if (discountType === "percent") {
          discount += lineSubtotal * Math.min(discountValue, 100) / 100;
        } else if (discountType === "amount") {
          discount += Math.min(discountValue, lineSubtotal);
        }
      });

      summary.querySelector("[data-quote-count]").textContent = String(rows.length);
      summary.querySelector("[data-quote-subtotal]").textContent = formatMoney(subtotal);
      summary.querySelector("[data-quote-discount]").textContent = formatMoney(discount);
      summary.querySelector("[data-quote-total]").textContent = formatMoney(Math.max(0, subtotal - discount));
      summary.querySelector("[data-quote-company]").textContent = form.querySelector("#create-company-name")?.value?.trim() || "-";
      summary.querySelector("[data-quote-validity]").textContent = form.querySelector("#create-valid-until")?.value || "-";
      summary.querySelector("[data-quote-number]").textContent = form.querySelector("#create-offer-number")?.value?.trim() || "-";
    };

    form.addEventListener("input", renderSummary);
    form.addEventListener("change", renderSummary);
    form.querySelector("[data-add-item-row]")?.addEventListener("click", () => window.setTimeout(renderSummary, 0));
    renderSummary();
  };

  initQuoteBuilderSummary();
  initAiNarration();
  initResultReveal();

  decisionSearchInput?.addEventListener("input", renderDecisionFilters);
  decisionFilterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      activeDecisionFilter = button.dataset.decisionFilter || "all";
      renderDecisionFilters();
    });
  });
  document.querySelectorAll("[data-decision-filter-shortcut]").forEach((button) => {
    button.addEventListener("click", () => {
      activeDecisionFilter = button.dataset.decisionFilterShortcut || "all";
      showWorkspace("apply");
      renderDecisionFilters();
    });
  });
  updateCorrectionSelectionState();

  const activePane = document.querySelector(".workspace-pane-stack > .tab-pane.active");
  const serverWorkspace = document.body.dataset.activeWorkspace || activePane?.id?.replace("workspace-pane-", "");
  const preferServerWorkspace = document.body.dataset.preferServerWorkspace === "true";

  let storedWorkspace = null;
  try {
    storedWorkspace = window.localStorage.getItem(workspaceStorageKey);
  } catch (_error) {
    storedWorkspace = null;
  }

  if (!preferServerWorkspace && storedWorkspace && storedWorkspace !== serverWorkspace) {
    showWorkspace(storedWorkspace);
  } else if (serverWorkspace) {
    syncWorkspaceChrome(serverWorkspace);
  } else if (workspaceLinks.length) {
    syncWorkspaceChrome(workspaceLinks[0].dataset.workspaceTarget);
  }
});
