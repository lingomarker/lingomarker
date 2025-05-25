class WordsTableComponent extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.itemsPerPage = parseInt(this.getAttribute('items-per-page')) || 10;

    // Client-side data management
    this._allWords = []; // Holds all fetched words
    this._filteredWords = []; // Holds words after search
    this._wordsToDisplay = []; // Holds words for the current page

    this.currentPage = 1;
    this._currentSearchQuery = '';
    this.searchTimeout = null;
  }

  connectedCallback() {
    this.renderLayout();
    this.fetchData();
  }

  _escapeHtml(unsafe) {
    if (unsafe === null || typeof unsafe === 'undefined') return '';
    return String(unsafe).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  static get observedAttributes() {
    return ['items-per-page'];
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'items-per-page' && oldValue !== newValue) {
      this.itemsPerPage = parseInt(newValue) || 10;
      if (this.shadowRoot.innerHTML) { // Check if component is already rendered
        this.currentPage = 1; // Reset to first page
        this._render(); // Re-render with new itemsPerPage
      }
    }
  }

  async fetchData() {
    const tableContainer = this.shadowRoot.getElementById('table-container');
    if (tableContainer) tableContainer.innerHTML = '<p class="loading-message">Loading words...</p>';

    // Fetch all data. Assumes /api/data without params returns all entries.
    const apiUrl = `/api/data`;
    try {
      const response = await fetch(apiUrl);
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
      }
      const result = await response.json();
      this._allWords = result.entries || [];
    } catch (error) {
      console.error('Failed to fetch words:', error);
      this._allWords = [];
      if (tableContainer) tableContainer.innerHTML = `<p class="error-message">Error loading words: ${error.message}</p>`;
    }
    this.currentPage = 1; // Reset to first page
    this._currentSearchQuery = this.shadowRoot.getElementById('search-input')?.value || ''; // Preserve existing search term or clear
    this._render();
  }

  _applyFiltersAndPagination() {
    let filtered = [...this._allWords];

    // 1. Apply Search Filter
    if (this._currentSearchQuery) {
      const query = this._currentSearchQuery.toLowerCase();
      filtered = filtered.filter(item =>
        (item.word && item.word.toLowerCase().includes(query)) ||
        (item.formsPipeSeparated && item.formsPipeSeparated.toLowerCase().includes(query))
      );
    }
    this._filteredWords = filtered;

    // 2. Apply Pagination
    const totalPages = Math.ceil(this._filteredWords.length / this.itemsPerPage);
    this.currentPage = Math.max(1, Math.min(this.currentPage, totalPages || 1));

    const startIndex = (this.currentPage - 1) * this.itemsPerPage;
    const endIndex = startIndex + this.itemsPerPage;
    this._wordsToDisplay = this._filteredWords.slice(startIndex, endIndex);
  }

  _render() {
    this._applyFiltersAndPagination();
    this.renderTableContent();
    this._renderPaginationControls();
  }

  renderLayout() {
    this.shadowRoot.innerHTML = `
            <style>
                :host {
                    display: block;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
                    margin-top: 20px;
                }
                .toolbar {
                    margin-bottom: 15px;
                    display: flex;
                    justify-content: flex-end;
                }
                #search-input {
                    padding: 8px 12px;
                    border: 1px solid #dddfe2;
                    border-radius: 6px;
                    font-size: 0.9em;
                    min-width: 250px;
                }
                #table-container {
                    overflow-x: auto; /* Allows horizontal scroll on very small screens if table content is too wide */
                }
                table {
                    width: 100%;
                    border-collapse: collapse;
                    font-size: 0.9em;
                }
                th, td {
                    border: 1px solid #ddd;
                    padding: 10px 12px;
                    text-align: left;
                    vertical-align: middle;
                }
                th {
                    background-color: #f0f2f5;
                    font-weight: 600;
                }
                .delete-btn {
                    padding: 6px 10px;
                    background-color: #dc3545;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 0.9em;
                }
                .delete-btn:hover {
                    background-color: #c82333;
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
                .loading-message, .error-message, .no-data-message {
                    text-align: center;
                    padding: 20px;
                    font-style: italic;
                    color: #555;
                }
                .error-message {
                    color: #721c24; /* From podcast_upload.html */
                    background-color: #f8d7da; /* From podcast_upload.html */
                    border: 1px solid #f5c6cb; /* From podcast_upload.html */
                    border-radius: 6px;
                }

                /* Responsive card-like display for small screens */
                @media screen and (max-width: 768px) {
                    table, thead, tbody, th, td, tr {
                        display: block;
                    }
                    thead tr {
                        position: absolute;
                        top: -9999px;
                        left: -9999px; /* Hide table headers */
                    }
                    tr {
                        border: 1px solid #dddfe2;
                        border-radius: 6px;
                        margin-bottom: 10px;
                        background-color: #fff;
                        box-shadow: 0 1px 3px rgba(0,0,0,0.05);
                    }
                    td {
                        border: none;
                        border-bottom: 1px solid #eee;
                        position: relative;
                        padding-left: 45%; 
                        padding-top: 8px;
                        padding-bottom: 8px;
                        text-align: right; 
                        min-height: 38px; /* Ensure consistent height */
                    }
                    td:last-child {
                        border-bottom: none;
                    }
                    td:before {
                        position: absolute;
                        top: 50%;
                        transform: translateY(-50%);
                        left: 10px;
                        width: 40%;
                        padding-right: 10px;
                        white-space: nowrap;
                        text-align: left;
                        font-weight: 600;
                        color: #4b4f56;
                    }
                    td:nth-of-type(1):before { content: "Word:"; }
                    td:nth-of-type(2):before { content: "Forms:"; }
                    td:nth-of-type(3):before { content: "Updated:"; }
                    td:nth-of-type(4):before { content: "Actions:"; }
                }
            </style>
            <h2>Words</h2>
            <div class="toolbar">
                <input type="search" id="search-input" placeholder="Search by Word or Forms...">
            </div>
            <div id="table-container">
                <!-- Table or cards will be rendered here -->
            </div>
            <div class="pagination-controls">
                <button id="prev-button" disabled>Previous</button>
                <span id="pagination-info" class="pagination-info">Page 1 of 1</span>
                <button id="next-button" disabled>Next</button>
            </div>
        `;

    this.shadowRoot.getElementById('search-input').addEventListener('input', (e) => {
      clearTimeout(this.searchTimeout);
      this.searchTimeout = setTimeout(() => {
        this._currentSearchQuery = e.target.value.trim();
        this.currentPage = 1; // Reset to first page on new search
        this._render();
      }, 400);
    });

    this.shadowRoot.getElementById('prev-button').addEventListener('click', this._onPrevPage.bind(this));
    this.shadowRoot.getElementById('next-button').addEventListener('click', this._onNextPage.bind(this));
  }

  renderTableContent() {
    const container = this.shadowRoot.getElementById('table-container');
    container.innerHTML = '';

    if (this._wordsToDisplay.length === 0) {
      if (this._currentSearchQuery) {
        container.innerHTML = `<p class="no-data-message">No words match your search "${this._escapeHtml(this._currentSearchQuery)}".</p>`;
      } else {
        container.innerHTML = '<p class="no-data-message">No words found.</p>';
      }
      return;
    }

    const table = document.createElement('table');
    table.innerHTML = `
            <thead>
                <tr>
                    <th>Word</th>
                    <th>Forms</th>
                    <th>Updated</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody></tbody>
        `;
    const tbody = table.querySelector('tbody');
    this._wordsToDisplay.forEach(item => {
      const row = tbody.insertRow();
      const formsDisplay = item.formsPipeSeparated ? item.formsPipeSeparated.split('|').map(f => this._escapeHtml(f.trim())).join(', ') : '';
      row.innerHTML = `
                <td>${this._escapeHtml(item.word) || 'N/A'}</td>
                <td>${formsDisplay}</td>
                <td>${item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : 'N/A'}</td>
                <td><button class="delete-btn" data-uuid="${this._escapeHtml(item.uuid)}">Delete</button></td>
            `;
      row.querySelector('.delete-btn').addEventListener('click', () => this.handleDelete(item.uuid));
    });
    container.appendChild(table);
  }

  _renderPaginationControls() {
    const prevButton = this.shadowRoot.getElementById('prev-button');
    const nextButton = this.shadowRoot.getElementById('next-button');
    const paginationInfo = this.shadowRoot.getElementById('pagination-info');

    const totalItems = this._filteredWords.length;
    const totalPages = Math.ceil(this._filteredWords.length / this.itemsPerPage);

    // this.currentPage is already adjusted in _applyFiltersAndPagination

    if (totalItems === 0) {
        paginationInfo.textContent = 'No words';
    } else {
        const startItem = (this.currentPage - 1) * this.itemsPerPage + 1;
        const endItem = Math.min(this.currentPage * this.itemsPerPage, totalItems);
        paginationInfo.textContent = `Showing ${startItem}-${endItem} of ${totalItems} (Page ${this.currentPage} of ${totalPages})`;
    }

    prevButton.disabled = this.currentPage === 1;
    nextButton.disabled = this.currentPage === totalPages || totalItems === 0;
  }

  _onPrevPage() {
    if (this.currentPage > 1) {
      this.currentPage--;
      this._render();
    }
  }

  _onNextPage() {
    const totalPages = Math.ceil(this._filteredWords.length / this.itemsPerPage);
    if (this.currentPage < totalPages) {
      this.currentPage++;
      this._render();
    }
  }

  
  async handleDelete(uuid) {
    if (!confirm('Are you sure you want to delete this word entry?')) return;

    try {
      const response = await fetch(`/api/entries/${uuid}`, { method: 'DELETE' });
      if (!response.ok) {
        let errorMsg = `Failed to delete word. Status: ${response.status}`;
        try {
          const errData = await response.json();
          errorMsg = errData.error || errData.message || errorMsg;
        } catch (e) { /* ignore if response is not json */ }
        throw new Error(errorMsg);
      }
      // Remove from _allWords and re-render
      this._allWords = this._allWords.filter(word => word.uuid !== uuid);
      // Current page might become invalid, _applyFiltersAndPagination will adjust it.
      this._render();
    } catch (error) {
      console.error('Delete error:', error);
      alert(`Error deleting word: ${error.message}`);
    }
  }

  reloadData() {
    this.shadowRoot.getElementById('search-input').value = ''; // Clear search input
    this._currentSearchQuery = '';
    this.fetchData(); // Refetch all data and render from page 1
  }
}
customElements.define('words-table-component', WordsTableComponent);
