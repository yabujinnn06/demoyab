document.addEventListener("DOMContentLoaded", () => {
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
  const applySubmitButtons = Array.from(document.querySelectorAll("[data-apply-submit]"));
  const decisionCards = Array.from(document.querySelectorAll("[data-decision-card]"));

  const getDecisionState = () => {
    const selectedCards = decisionCards.filter((card) => {
      const checkbox = card.querySelector("[data-apply-checkbox]");
      return checkbox?.checked && !checkbox.disabled;
    });
    const waitingCards = decisionCards.filter((card) => {
      const select = card.querySelector("[data-manual-match]");
      const checkbox = card.querySelector("[data-apply-checkbox]");
      return card.dataset.decisionStatus !== "ONAY" && checkbox?.disabled && select && !select.value;
    });
    const approvedCards = decisionCards.filter((card) => card.dataset.decisionStatus === "ONAY");
    return { selectedCards, waitingCards, approvedCards };
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
    const { selectedCards, waitingCards } = getDecisionState();
    const selectedCount = selectedCards.length;
    selectedCountLabels.forEach((label) => {
      label.textContent = String(selectedCount);
    });
    waitingCountLabels.forEach((label) => {
      label.textContent = `${waitingCards.length} satır`;
    });
    applySubmitButtons.forEach((button) => {
      button.disabled = selectedCount === 0;
      button.textContent = selectedCount === 0
        ? "Önce düzeltilecek satır seç"
        : `Seçili düzeltmeleri hazırla (${selectedCount})`;
    });
  };

  applyCheckboxes.forEach((checkbox) => {
    checkbox.addEventListener("change", updateCorrectionSelectionState);
  });

  document.querySelectorAll("[data-manual-match]").forEach((select) => {
    select.addEventListener("change", () => {
      const decisionCard = select.closest(".decision-card");
      const checkbox = decisionCard?.querySelector("[data-apply-checkbox]");
      const label = decisionCard?.querySelector("[data-apply-label]");
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
      updateCorrectionSelectionState();
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
