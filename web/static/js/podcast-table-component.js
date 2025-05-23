// /home/igor/lingomarker/lingomarker/web/static/js/podcast-table-component.js
class PodcastTableComponent extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }); // Create a Shadow DOM

    // --- Component State & Configuration ---
    this._allPodcasts = []; // Holds all fetched podcasts
    this._filteredPodcasts = []; // Holds podcasts after search
    this._podcastsToDisplay = []; // Holds podcasts for the current page

    this._currentPage = 1;
    this._itemsPerPage = parseInt(this.getAttribute('items-per-page'), 10) || 10;
    this._currentSearchQuery = '';

    this._apiEndpoint = this.getAttribute('api-endpoint') || '/api/podcasts';
    this._pollIntervalId = null;

    // --- Initial Structure ---
    this.shadowRoot.innerHTML = `
            <style>
                /* Basic Reset & Component Styling */
                :host {
                    display: block; /* Ensure the component takes up space */
                    font-family: sans-serif;
                    width: 100%;
                }
                .search-container {
                    margin-bottom: 1em;
                }
                .search-container input {
                    padding: 0.5em;
                    font-size: 1em;
                    width: calc(100% - 1.2em); /* Adjust for padding */
                    max-width: 400px;
                    box-sizing: border-box;
                }
                table {
                    width: 100%;
                    border-collapse: collapse;
                    margin-bottom: 1em;
                }
                th, td {
                    border: 1px solid #ddd;
                    padding: 8px;
                    text-align: left;
                }
                th {
                    background-color: #f2f2f2;
                }
                .status-cell .spinner {
                    font-size: 0.8em;
                    display: inline-block;
                    animation: spin 1s linear infinite;
                }
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                .actions-cell button {
                    padding: 5px 10px;
                    margin-right: 5px;
                    cursor: pointer;
                }
                .actions-cell button:disabled {
                    cursor: not-allowed;
                    opacity: 0.6;
                }
                .pagination-controls {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-top: 1em;
                }
                .pagination-controls button {
                    padding: 8px 12px;
                }
                .pagination-info {
                    font-size: 0.9em;
                }
                .message-area {
                    margin-bottom: 1em;
                    padding: 0.5em;
                    border-radius: 4px;
                }
                .message-area.success {
                    background-color: #e6ffed;
                    border: 1px solid #b7ebc0;
                    color: #257942;
                }
                .message-area.error {
                    background-color: #ffebee;
                    border: 1px solid #ffcdd2;
                    color: #c62828;
                }
                .loading-message, .no-results-message {
                    text-align: center;
                    padding: 20px;
                    font-style: italic;
                    color: #555;
                }

                /* Responsive Card View - to be refined */
                @media screen and (max-width: 768px) {
                    table thead {
                        display: none;
                    }
                    table tr {
                        display: block;
                        margin-bottom: 1em;
                        border: 1px solid #ccc;
                        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                    }
                    table td {
                        display: block;
                        text-align: right;
                        padding-left: 50%; /* Make space for the label */
                        position: relative;
                        border-bottom: 1px dotted #eee;
                    }
                    table td::before {
                        content: attr(data-label);
                        position: absolute;
                        left: 10px;
                        width: calc(50% - 20px);
                        padding-right: 10px;
                        text-align: left;
                        font-weight: bold;
                        white-space: nowrap;
                    }
                    table td:last-child {
                        border-bottom: 0;
                    }
                    .actions-cell {
                        text-align: center; /* Center buttons in card view */
                    }
                }
            </style>

            <div class="message-area" id="component-message"></div>
            <div class="search-container">
                <input type="search" id="search-input" placeholder="Search by Producer, Series, or Episode...">
            </div>

            <table id="podcast-table-element">
                <thead>
                    <tr>
                        <th>Producer</th>
                        <th>Series</th>
                        <th>Episode</th>
                        <th>Uploaded</th>
                        <th>Status</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody id="podcast-tbody-element">
                    <tr><td colspan="6" class="loading-message">Initializing component...</td></tr>
                </tbody>
            </table>

            <div class="pagination-controls">
                <button id="prev-button" disabled>Previous</button>
                <span id="pagination-info" class="pagination-info">Page 1 of 1</span>
                <button id="next-button" disabled>Next</button>
            </div>
        `;
  }

  connectedCallback() {
    console.log('PodcastTableComponent connected to DOM.');
    // Setup Event Listeners
    this.shadowRoot.getElementById('search-input').addEventListener('input', this._onSearch.bind(this));
    this.shadowRoot.getElementById('prev-button').addEventListener('click', this._onPrevPage.bind(this));
    this.shadowRoot.getElementById('next-button').addEventListener('click', this._onNextPage.bind(this));
    this.shadowRoot.getElementById('podcast-tbody-element').addEventListener('click', this._handleTableActions.bind(this));

    // Initial data fetch
    this._fetchData();
  }

  disconnectedCallback() {
    console.log('PodcastTableComponent disconnected from DOM.');
    this._stopPolling(); // Cleanup polling interval
  }

  // --- Helper to escape HTML ---
  _escapeHtml(unsafe) {
    if (unsafe === null || typeof unsafe === 'undefined') return '';
    return String(unsafe)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // --- Main Render Orchestrator (will be expanded) ---
  _render() {
    // This method will now orchestrate the display based on current state
    this._applyFiltersAndPagination(); // Apply search and pagination
    this._renderTableRows();      // Render the table with _podcastsToDisplay
    this._renderPaginationControls(); // Update pagination controls
    this._startPollingIfNeeded();     // Handle status polling
  }

  // --- Data Fetching ---
  async _fetchData() {
    const tbody = this.shadowRoot.getElementById('podcast-tbody-element');
    tbody.innerHTML = `<tr><td colspan="6" class="loading-message">Fetching podcasts...</td></tr>`;
    try {
      const response = await fetch(this._apiEndpoint);
      if (!response.ok) {
        throw new Error(`Failed to fetch podcasts: ${response.status} ${response.statusText}`);
      }
      const data = await response.json();
      this._allPodcasts = data.sort((a, b) => new Date(b.uploadTime) - new Date(a.uploadTime)); // Default sort by upload time desc
      this._showMessage(''); // Clear any previous messages
    } catch (error) {
      console.error('Error fetching podcasts:', error);
      this._allPodcasts = [];
      tbody.innerHTML = `<tr><td colspan="6" class="error-message">Error loading podcasts: ${this._escapeHtml(error.message)}</td></tr>`;
      this._showMessage(`Error: ${error.message}`, 'error');
    }
    this._currentPage = 1; // Reset to first page after fetch
    this._render(); // Render with fetched data (or error state)
  }

  // --- Search, Filtering, and Pagination Logic ---
  _applyFiltersAndPagination() {
    let filtered = [...this._allPodcasts];

    // 1. Apply Search Filter
    if (this._currentSearchQuery) {
      const query = this._currentSearchQuery.toLowerCase();
      filtered = filtered.filter(p =>
        (p.producer && p.producer.toLowerCase().includes(query)) ||
        (p.series && p.series.toLowerCase().includes(query)) ||
        (p.episode && p.episode.toLowerCase().includes(query))
      );
    }
    this._filteredPodcasts = filtered;

    // 2. Apply Pagination
    const startIndex = (this._currentPage - 1) * this._itemsPerPage;
    const endIndex = startIndex + this._itemsPerPage;
    this._podcastsToDisplay = this._filteredPodcasts.slice(startIndex, endIndex);
  }

  // --- Rendering Table Rows ---
  _renderTableRows() {
    const tbody = this.shadowRoot.getElementById('podcast-tbody-element');
    tbody.innerHTML = ''; // Clear previous rows

    if (this._podcastsToDisplay.length === 0) {
      if (this._currentSearchQuery) {
        tbody.innerHTML = `<tr><td colspan="6" class="no-results-message">No podcasts match your search "${this._escapeHtml(this._currentSearchQuery)}".</td></tr>`;
      } else {
        tbody.innerHTML = `<tr><td colspan="6" class="no-results-message">No podcasts uploaded yet.</td></tr>`;
      }
      return;
    }

    this._podcastsToDisplay.forEach(podcast => {
      const row = document.createElement('tr');
      row.dataset.podcastId = podcast.id;
      row.dataset.status = podcast.status;

      const uploadDate = new Date(podcast.uploadTime).toLocaleString();

      let statusHtml = '';
      switch (podcast.status) {
        case 'uploaded':
        case 'transcribing':
          statusHtml = `<span>${this._escapeHtml(podcast.status)} <span class="spinner">⏳</span></span>`;
          break;
        case 'completed':
          statusHtml = '<span style="color: green;">✓ Completed</span>';
          break;
        case 'failed':
          statusHtml = `<span style="color: red;">✗ Failed</span>`;
          if (podcast.errorMessage) {
            statusHtml += ` <small style="display:block; color: #777;">${this._escapeHtml(podcast.errorMessage)}</small>`;
          }
          break;
        default:
          statusHtml = this._escapeHtml(podcast.status);
      }

      let actionsHtml = '';
      actionsHtml += `<button class="action-open" data-id="${podcast.id}" ${podcast.status !== 'completed' ? 'disabled' : ''}>Open</button> `;
      actionsHtml += `<button class="action-delete" data-id="${podcast.id}">Delete</button>`;

      row.innerHTML = `
        <td data-label="Producer">${this._escapeHtml(podcast.producer)}</td>
        <td data-label="Series">${this._escapeHtml(podcast.series)}</td>
        <td data-label="Episode">${this._escapeHtml(podcast.episode)}</td>
        <td data-label="Uploaded">${uploadDate}</td>
        <td data-label="Status" class="status-cell">${statusHtml}</td>
        <td data-label="Actions" class="actions-cell">${actionsHtml}</td>
      `;
      tbody.appendChild(row);
    });
  }

  // --- Rendering Pagination Controls ---
  _renderPaginationControls() {
    const prevButton = this.shadowRoot.getElementById('prev-button');
    const nextButton = this.shadowRoot.getElementById('next-button');
    const paginationInfo = this.shadowRoot.getElementById('pagination-info');

    const totalItems = this._filteredPodcasts.length;
    const totalPages = Math.ceil(totalItems / this._itemsPerPage);

    this._currentPage = Math.max(1, Math.min(this._currentPage, totalPages || 1));

    if (totalItems === 0) {
        paginationInfo.textContent = 'No podcasts';
    } else {
        const startItem = (this._currentPage - 1) * this._itemsPerPage + 1;
        const endItem = Math.min(this._currentPage * this._itemsPerPage, totalItems);
        paginationInfo.textContent = `Showing ${startItem}-${endItem} of ${totalItems} (Page ${this._currentPage} of ${totalPages})`;
    }

    prevButton.disabled = this._currentPage === 1;
    nextButton.disabled = this._currentPage === totalPages || totalItems === 0;
  }

  // --- Event Handlers (stubs for now, to be fully implemented) ---
  _onSearch(event) {
    this._currentSearchQuery = event.target.value;
    this._currentPage = 1; // Reset to first page on new search
    this._render();
  }

  _onPrevPage() {
    if (this._currentPage > 1) {
      this._currentPage--;
      this._render();
    }
  }

  _onNextPage() {
    const totalPages = Math.ceil(this._filteredPodcasts.length / this._itemsPerPage);
    if (this._currentPage < totalPages) {
      this._currentPage++;
      this._render();
    }
  }

  _handleTableActions(event) {
    const target = event.target;
    const podcastId = target.dataset.id;

    if (target.classList.contains('action-delete')) {
      const row = target.closest('tr');
      const episodeTitle = row?.cells[2]?.textContent || `ID ${podcastId}`;
      if (confirm(`Are you sure you want to delete podcast "${this._escapeHtml(episodeTitle)}"? This cannot be undone.`)) {
        this._deletePodcast(podcastId, row);
      }
    } else if (target.classList.contains('action-open') && !target.disabled) {
      this._openPodcast(podcastId);
    }
  }

  async _deletePodcast(podcastId, rowElement) {
    const deleteButton = rowElement.querySelector('.action-delete');
    if (deleteButton) {
        deleteButton.disabled = true;
        deleteButton.textContent = 'Deleting...';
    }
    this._showMessage(''); // Clear previous messages

    try {
      const response = await fetch(`${this._apiEndpoint}/${podcastId}`, {
        method: 'DELETE'
      });
      const result = await response.json(); // Expecting JSON like { message: "..." } or { error: "..." }

      if (response.ok) {
        this._showMessage(`✅ ${result.message || 'Podcast deleted successfully.'}`, 'success');
        // Remove from _allPodcasts and re-render
        this._allPodcasts = this._allPodcasts.filter(p => p.id !== podcastId);
        this._render(); // This will re-apply filters, pagination, and re-render table & controls
      } else {
        this._showMessage(`❌ Error: ${result.error || `Deletion failed (${response.status})`}`, 'error');
        if (deleteButton) {
            deleteButton.disabled = false;
            deleteButton.textContent = 'Delete';
        }
      }
    } catch (error) {
      console.error("Delete podcast error:", error);
      this._showMessage(`❌ Network Error: ${error.message}`, 'error');
      if (deleteButton) {
          deleteButton.disabled = false;
          deleteButton.textContent = 'Delete';
      }
    }
  }

  _openPodcast(podcastId) {
    // Assuming your podcast play page is at /podcasts/play/:id
    window.location.href = `/podcasts/play/${podcastId}`;
  }

  // --- Status Polling Methods ---
  _startPollingIfNeeded() {
    const requiresPolling = this._allPodcasts.some(p => p.status === 'uploaded' || p.status === 'transcribing');

    if (requiresPolling && !this._pollIntervalId) {
      console.log("PodcastTableComponent: Starting status polling...");
      this._pollIntervalId = setInterval(() => this._pollPodcastStatuses(), 10000); // Poll every 10 seconds
    } else if (!requiresPolling && this._pollIntervalId) {
      this._stopPolling();
    }
  }

  _stopPolling() {
    if (this._pollIntervalId) {
      clearInterval(this._pollIntervalId);
      this._pollIntervalId = null;
      console.log("PodcastTableComponent: Status polling stopped.");
    }
  }

  async _pollPodcastStatuses() {
    console.log("PodcastTableComponent: Polling for status updates...");
    const podcastsCurrentlyProcessing = this._allPodcasts.filter(p => p.status === 'uploaded' || p.status === 'transcribing');

    if (podcastsCurrentlyProcessing.length === 0) {
      this._stopPolling();
      return;
    }

    try {
      // Fetch the full list again to get the latest statuses
      const response = await fetch(this._apiEndpoint);
      if (!response.ok) {
        console.error(`Polling failed: ${response.status}. Stopping poll.`);
        this._stopPolling(); // Stop polling on API error to prevent spamming
        return;
      }
      const latestPodcasts = await response.json();

      let changed = false;
      this._allPodcasts = this._allPodcasts.map(oldPodcast => {
        const latestData = latestPodcasts.find(p => p.id === oldPodcast.id);
        if (latestData && latestData.status !== oldPodcast.status) {
          console.log(`Status changed for ${oldPodcast.id}: ${oldPodcast.status} -> ${latestData.status}`);
          changed = true;
          return { ...oldPodcast, ...latestData }; // Update with all latest data
        }
        return oldPodcast;
      });

      if (changed) {
        this._render(); // Re-render if any status changed
      }

      // Check if polling still needed after updates
      const stillProcessing = this._allPodcasts.some(p => p.status === 'uploaded' || p.status === 'transcribing');
      if (!stillProcessing) {
        this._stopPolling();
      }

    } catch (error) {
      console.error("Error during status polling:", error);
      // Potentially stop polling after a few consecutive errors
    }
  }

  // --- User Message Display ---
  _showMessage(text, type = 'info') { // type can be 'info', 'success', 'error'
    const messageArea = this.shadowRoot.getElementById('component-message');
    messageArea.textContent = text;
    messageArea.className = 'message-area'; // Reset classes
    if (type) {
      messageArea.classList.add(type);
    }
  }
}
// Define the custom element
customElements.define('podcast-table-component', PodcastTableComponent);
