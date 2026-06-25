// ParkIt Popup Controller

let currentTabs = [];

document.addEventListener('DOMContentLoaded', () => {
  initParkView();
  setupEventListeners();
});

// Setup event listeners for UI buttons and inputs
function setupEventListeners() {
  document.getElementById('viewSessionsBtn').addEventListener('click', () => {
    switchView('sessions');
  });

  document.getElementById('backBtn').addEventListener('click', () => {
    switchView('park');
  });

  document.getElementById('toggleSelectBtn').addEventListener('click', toggleSelectAll);

  document.getElementById('parkBtn').addEventListener('click', handleParkAction);

  // Submit on Enter keypress inside label input if tabs are checked
  document.getElementById('labelInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const selectedCount = document.querySelectorAll('.tab-checkbox:checked').length;
      if (selectedCount > 0) {
        handleParkAction();
      }
    }
  });

  document.getElementById('searchInput').addEventListener('input', (e) => {
    renderSessions(e.target.value.trim());
  });
}

// Switch between Park View and Sessions View
function switchView(viewName) {
  const parkView = document.getElementById('parkView');
  const sessionsView = document.getElementById('sessionsView');
  
  if (viewName === 'sessions') {
    parkView.style.display = 'none';
    sessionsView.style.display = 'block';
    renderSessions();
    document.getElementById('searchInput').focus();
  } else {
    parkView.style.display = 'block';
    sessionsView.style.display = 'none';
    initParkView();
  }
}

// Query tabs and initialize Park View checklist
async function initParkView() {
  try {
    // Query tabs in current window, excluding pinned tabs
    const tabs = await chrome.tabs.query({ currentWindow: true });
    currentTabs = tabs.filter(t => !t.pinned);

    document.getElementById('activeCount').textContent = `${currentTabs.length} TABS`;

    // Suggest default label
    const labelInput = document.getElementById('labelInput');
    if (!labelInput.value) {
      labelInput.value = suggestLabel(currentTabs);
    }

    renderTabsChecklist();
    updateSelectionSummary();
  } catch (err) {
    console.error("Error initializing Park View:", err);
  }
}

// Calculate hostnames to suggest session label
function suggestLabel(tabs) {
  if (tabs.length === 0) return 'New Session';
  
  const domains = {};
  tabs.forEach(tab => {
    try {
      if (tab.url) {
        const domain = new URL(tab.url).hostname.replace('www.', '');
        if (domain && domain !== 'newtab') {
          domains[domain] = (domains[domain] || 0) + 1;
        }
      }
    } catch (e) {
      // Ignore URL parsing errors for special chrome schemas
    }
  });

  const sortedDomains = Object.entries(domains).sort((a, b) => b[1] - a[1]);
  const topDomain = sortedDomains[0]?.[0];

  if (topDomain) {
    return `${topDomain} research`;
  }
  
  // Fallback to active tab title
  const activeTab = tabs.find(t => t.active) || tabs[0];
  if (activeTab && activeTab.title) {
    return activeTab.title.substring(0, 30).trim();
  }

  return 'New Session';
}

// Render active tabs as a checklist
function renderTabsChecklist() {
  const tabsList = document.getElementById('tabsList');
  if (currentTabs.length === 0) {
    tabsList.innerHTML = '<div class="empty-state-text">NO_PARKABLE_TABS_DETECTED</div>';
    return;
  }

  tabsList.innerHTML = currentTabs.map((tab, idx) => {
    const title = tab.title || tab.url || 'Untitled';
    const favIcon = tab.favIconUrl || 'icons/icon.png';
    const isChecked = true; // Checked by default
    const isActiveClass = tab.active ? 'active-tab' : '';
    
    return `
      <div class="tab-card ${isActiveClass}" data-index="${idx}">
        <label class="tab-label">
          <input type="checkbox" class="tab-checkbox" data-id="${tab.id}" ${isChecked ? 'checked' : ''} />
          <span class="custom-checkbox"></span>
          <img class="tab-favicon" src="${favIcon}" />
          <span class="tab-title-text" title="${escapeHtml(title)}\n${escapeHtml(tab.url)}">
            ${escapeHtml(truncate(title, 42))}
          </span>
        </label>
      </div>
    `;
  }).join('');

  // Bind fallback for broken or restricted favicons programmatically to avoid CSP violations
  tabsList.querySelectorAll('.tab-favicon').forEach(img => {
    img.addEventListener('error', () => {
      img.src = 'icons/icon.png';
    });
  });

  // Add change listeners to checkboxes
  tabsList.querySelectorAll('.tab-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      updateSelectionSummary();
    });
  });
}

// Update the checkbox list summary count
function updateSelectionSummary() {
  const checkboxes = document.querySelectorAll('.tab-checkbox:checked');
  const total = currentTabs.length;
  const selectedCount = checkboxes.length;
  
  document.getElementById('selectionSummary').textContent = `${selectedCount} / ${total} tabs selected to park`;
  
  // Disable Park button if 0 tabs are selected
  document.getElementById('parkBtn').disabled = (selectedCount === 0);
  
  const toggleSelectBtn = document.getElementById('toggleSelectBtn');
  if (selectedCount === 0) {
    toggleSelectBtn.textContent = 'SELECT_ALL';
  } else {
    toggleSelectBtn.textContent = 'DESELECT_ALL';
  }
}

// Toggle select all / deselect all tabs
function toggleSelectAll() {
  const checkboxes = document.querySelectorAll('.tab-checkbox');
  const checkedCount = document.querySelectorAll('.tab-checkbox:checked').length;
  const shouldCheck = checkedCount === 0;

  checkboxes.forEach(cb => {
    cb.checked = shouldCheck;
  });

  updateSelectionSummary();
}

// Handle Click on Park button
async function handleParkAction() {
  const labelInput = document.getElementById('labelInput');
  const label = labelInput.value.trim();

  if (!label) {
    labelInput.style.borderColor = 'var(--danger-color)';
    labelInput.placeholder = 'LABEL_IS_REQUIRED';
    labelInput.focus();
    return;
  }

  // Get selected tab IDs
  const checkedBoxes = Array.from(document.querySelectorAll('.tab-checkbox:checked'));
  if (checkedBoxes.length === 0) {
    alert("Please select at least one tab to park.");
    return;
  }

  const selectedTabIds = checkedBoxes.map(cb => parseInt(cb.dataset.id, 10));
  const selectedTabsData = currentTabs.filter(t => selectedTabIds.includes(t.id));

  try {
    // 1. Save session to local storage
    await saveSessionToStorage(label, selectedTabsData);

    // 2. Perform tab closing sequence
    // Check if we are closing all open tabs in this window.
    // If so, we must create a new blank tab so the Chrome window doesn't close.
    const allTabsInWindow = await chrome.tabs.query({ currentWindow: true });
    const remainingTabsCount = allTabsInWindow.length - selectedTabIds.length;

    if (remainingTabsCount === 0) {
      await chrome.tabs.create({ url: 'chrome://newtab' });
    }

    // Close selected tabs
    await chrome.tabs.remove(selectedTabIds);
    
    // Close the extension popup
    window.close();
  } catch (err) {
    console.error("Error executing park sequence:", err);
  }
}

// Save session array to chrome.storage.local
async function saveSessionToStorage(label, tabs) {
  const session = {
    id: Date.now().toString(),
    label: label,
    savedAt: Date.now(),
    tabs: tabs.map(t => ({
      url: t.url || '',
      title: t.title || 'Untitled',
      favIconUrl: t.favIconUrl || ''
    }))
  };

  const result = await chrome.storage.local.get({ sessions: [] });
  result.sessions.unshift(session);
  await chrome.storage.local.set({ sessions: result.sessions });
}

// Render Sessions View
async function renderSessions(filterText = '') {
  const listContainer = document.getElementById('sessionsList');
  try {
    const result = await chrome.storage.local.get({ sessions: [] });
    let sessions = result.sessions;

    if (filterText) {
      sessions = sessions.filter(s => 
        s.label.toLowerCase().includes(filterText.toLowerCase())
      );
    }

    if (sessions.length === 0) {
      listContainer.innerHTML = '<div class="empty-state-text">NO_SAVED_SESSIONS_FOUND</div>';
      return;
    }

    listContainer.innerHTML = sessions.map(session => {
      return `
        <div class="session-card" data-id="${session.id}">
          <div class="session-header">
            <div class="session-header-main">
              <span class="session-label" title="${escapeHtml(session.label)}">${escapeHtml(session.label)}</span>
              <span class="session-count-badge">${session.tabs.length} TABS</span>
            </div>
            <div class="session-time">${timeAgo(session.savedAt)}</div>
          </div>
          
          <!-- Inner list of URLs inside session -->
          <div class="session-tabs-preview" id="preview-${session.id}" style="display: none;">
            ${session.tabs.map(t => `
              <div class="preview-item">
                <img class="preview-favicon" src="${t.favIconUrl || 'icons/icon.png'}" />
                <a href="${t.url}" target="_blank" class="preview-link" title="${escapeHtml(t.title)}\n${escapeHtml(t.url)}">
                  ${escapeHtml(truncate(t.title, 45))}
                </a>
              </div>
            `).join('')}
          </div>

          <div class="session-actions">
            <button class="card-btn restore-window-btn" data-id="${session.id}" title="Restore in new window">WINDOW</button>
            <button class="card-btn restore-group-btn" data-id="${session.id}" title="Restore as tab group here">GROUP</button>
            <button class="card-btn preview-btn" data-id="${session.id}">PREVIEW</button>
            <button class="card-btn delete-btn" data-id="${session.id}">DELETE</button>
          </div>
        </div>
      `;
    }).join('');

    // Bind fallback for broken or restricted preview favicons programmatically to avoid CSP violations
    listContainer.querySelectorAll('.preview-favicon').forEach(img => {
      img.addEventListener('error', () => {
        img.src = 'icons/icon.png';
      });
    });

    attachSessionCardHandlers(sessions);
  } catch (err) {
    console.error("Error loading saved sessions:", err);
  }
}

// Bind handlers to restore, preview, and delete buttons
function attachSessionCardHandlers(sessions) {
  const container = document.getElementById('sessionsList');

  // Restore Window button handler
  container.querySelectorAll('.restore-window-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const session = sessions.find(s => s.id === btn.dataset.id);
      if (session) {
        restoreSession(session);
      }
    });
  });

  // Restore Group button handler
  container.querySelectorAll('.restore-group-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const session = sessions.find(s => s.id === btn.dataset.id);
      if (session) {
        restoreSessionAsGroup(session);
      }
    });
  });

  // Preview button handler
  container.querySelectorAll('.preview-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const previewDiv = document.getElementById(`preview-${btn.dataset.id}`);
      if (previewDiv.style.display === 'none') {
        previewDiv.style.display = 'block';
        btn.textContent = 'HIDE';
        btn.classList.add('active');
      } else {
        previewDiv.style.display = 'none';
        btn.textContent = 'PREVIEW';
        btn.classList.remove('active');
      }
    });
  });

  // Two-step inline delete button handler
  container.querySelectorAll('.delete-btn').forEach(btn => {
    let resetTimeout;
    const resetBtn = () => {
      btn.textContent = 'DELETE';
      btn.classList.remove('armed');
      clearTimeout(resetTimeout);
    };

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.classList.contains('armed')) {
        deleteSession(btn.dataset.id);
      } else {
        // Reset all other armed delete buttons
        container.querySelectorAll('.delete-btn.armed').forEach(other => {
          other.textContent = 'DELETE';
          other.classList.remove('armed');
        });
        
        btn.textContent = 'SURE?';
        btn.classList.add('armed');
        resetTimeout = setTimeout(resetBtn, 3000);
      }
    });

    btn.addEventListener('mouseleave', () => {
      if (btn.classList.contains('armed')) {
        resetTimeout = setTimeout(resetBtn, 1000);
      }
    });

    btn.addEventListener('mouseenter', () => {
      clearTimeout(resetTimeout);
    });
  });
}

// Restore all tabs from a session in a new window
async function restoreSession(session) {
  if (!session.tabs || session.tabs.length === 0) return;

  try {
    // Open the first tab in a new window
    const newWindow = await chrome.windows.create({
      url: session.tabs[0].url,
      focused: true
    });

    // Open subsequent tabs in the same window
    for (let i = 1; i < session.tabs.length; i++) {
      await chrome.tabs.create({
        windowId: newWindow.id,
        url: session.tabs[i].url
      });
    }
  } catch (err) {
    console.error("Error restoring session:", err);
  }
}

// Restore session as a named Chrome Tab Group in current window
async function restoreSessionAsGroup(session) {
  if (!session.tabs || session.tabs.length === 0) return;

  try {
    const createdTabIds = [];
    for (const t of session.tabs) {
      const tab = await chrome.tabs.create({
        url: t.url,
        active: false
      });
      createdTabIds.push(tab.id);
    }

    // Create a group containing all these tabs in the current window
    const groupId = await chrome.tabs.group({ tabIds: createdTabIds });

    // Update group properties with session label name and mustard yellow color representation
    await chrome.tabGroups.update(groupId, {
      title: session.label.substring(0, 30),
      color: 'yellow'
    });
  } catch (err) {
    console.error("Error restoring session as tab group:", err);
  }
}

// Delete session from storage
async function deleteSession(id) {
  try {
    const result = await chrome.storage.local.get({ sessions: [] });
    const updatedSessions = result.sessions.filter(s => s.id !== id);
    await chrome.storage.local.set({ sessions: updatedSessions });
    renderSessions(document.getElementById('searchInput').value.trim());
  } catch (err) {
    console.error("Error deleting session:", err);
  }
}

// Escape helper to prevent XSS injection
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
}

// Truncate long tab titles helper
function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len) + '...' : str;
}

// Generate relative time representation
function timeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return 'just now';
  
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return `${hours}h ago`;
  
  const days = Math.floor(diff / 86400000);
  return `${days}d ago`;
}
