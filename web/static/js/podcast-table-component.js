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
    // Event Listeners (will be added in subsequent steps)
    // this.shadowRoot.getElementById('search-input').addEventListener('input', this._onSearch.bind(this));
    // this.shadowRoot.getElementById('prev-button').addEventListener('click', this._onPrevPage.bind(this));
    // this.shadowRoot.getElementById('next-button').addEventListener('click', this._onNextPage.bind(this));
    // this.shadowRoot.getElementById('podcast-tbody-element').addEventListener('click', this._handleTableActions.bind(this));

    // Initial data fetch (will be implemented next)
    // this._fetchData();
    this._render(); // Initial render with placeholder
  }

  disconnectedCallback() {
    console.log('PodcastTableComponent disconnected from DOM.');
    // this._stopPolling(); // Cleanup polling interval
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
    const tbody = this.shadowRoot.getElementById('podcast-tbody-element');
    tbody.innerHTML = '<tr><td colspan="6" class="loading-message">Loading podcasts...</td></tr>';
    // In future steps, this will:
    // 1. Apply search filter
    // 2. Apply pagination
    // 3. Call _renderTableRows with the processed data
    // 4. Call _renderPaginationControls
    // 5. Call _startPollingIfNeeded
  }

  // --- Placeholder for other methods to be added ---
  // _fetchData() { /* ... */ }
  // _onSearch(event) { /* ... */ }
  // _applyFiltersAndPagination() { /* ... */ }
  // _renderTableRows(podcasts) { /* ... */ }
  // _renderPaginationControls() { /* ... */ }
  // _onPrevPage() { /* ... */ }
  // _onNextPage() { /* ... */ }
  // _handleTableActions(event) { /* ... */ }
  // _deletePodcast(podcastId, rowElement) { /* ... */ }
  // _openPodcast(podcastId) { /* ... */ }
  // _startPollingIfNeeded() { /* ... */ }
  // _pollPodcastStatuses() { /* ... */ }
  // _stopPolling() { /* ... */ }
  // _showMessage(text, type = 'info') { /* ... */ }
}

// Define the custom element
customElements.define('podcast-table-component', PodcastTableComponent);
