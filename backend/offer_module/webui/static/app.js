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

  document.querySelectorAll("[data-manual-match]").forEach((select) => {
    select.addEventListener("change", () => {
      if (!select.value) {
        return;
      }
      const decisionCard = select.closest(".decision-card");
      const checkbox = decisionCard?.querySelector("[data-apply-checkbox]");
      if (checkbox) {
        checkbox.checked = true;
      }
    });
  });

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
