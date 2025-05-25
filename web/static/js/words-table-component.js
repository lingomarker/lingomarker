class WordsTableComponent extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this.itemsPerPage = parseInt(this.getAttribute('items-per-page')) || 10;
        this.currentPage = 1;
        this.searchTerm = '';
        this.data = [];
        this.totalItems = 0;
        this.searchTimeout = null;
    }

    connectedCallback() {
        this.renderLayout();
        this.fetchData();
    }

    static get observedAttributes() {
        return ['items-per-page'];
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (name === 'items-per-page' && oldValue !== newValue) {
            this.itemsPerPage = parseInt(newValue) || 10;
            if (this.shadowRoot.innerHTML) { // Check if component is already rendered
                this.fetchData(1, this.searchTerm); // Refetch data with new itemsPerPage
            }
        }
    }

    async fetchData(page = this.currentPage, searchTerm = this.searchTerm) {
        const tableContainer = this.shadowRoot.getElementById('table-container');
        if (tableContainer) tableContainer.innerHTML = '<p class="loading-message">Loading words...</p>';

        const apiUrl = `/api/data?page=${page}&limit=${this.itemsPerPage}&search=${encodeURIComponent(searchTerm)}`;
        try {
            const response = await fetch(apiUrl);
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
            }
            const result = await response.json();
            this.data = result.entries || [];
            this.totalItems = result.total || 0;
            this.currentPage = page;
            this.searchTerm = searchTerm;
        } catch (error) {
            console.error('Failed to fetch words:', error);
            this.data = [];
            this.totalItems = 0;
            if (tableContainer) tableContainer.innerHTML = `<p class="error-message">Error loading words: ${error.message}</p>`;
        }
        this.renderTableContent();
        this.renderPagination();
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
                .pagination-container {
                    margin-top: 15px;
                    text-align: center;
                }
                .pagination-container button, .pagination-container span {
                    margin: 0 5px;
                    padding: 6px 10px;
                    border: 1px solid #dddfe2;
                    background-color: #fff;
                    border-radius: 4px;
                    cursor: pointer;
                }
                .pagination-container button:disabled {
                    cursor: not-allowed;
                    opacity: 0.6;
                }
                .pagination-container span {
                    cursor: default;
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
            <div id="pagination-container">
                <!-- Pagination controls will be rendered here -->
            </div>
        `;

        this.shadowRoot.getElementById('search-input').addEventListener('input', (e) => {
            clearTimeout(this.searchTimeout);
            this.searchTimeout = setTimeout(() => {
                this.fetchData(1, e.target.value.trim());
            }, 400);
        });
    }

    renderTableContent() {
        const container = this.shadowRoot.getElementById('table-container');
        container.innerHTML = ''; 

        if (this.data.length === 0) {
            container.innerHTML = '<p class="no-data-message">No words found.</p>';
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
        this.data.forEach(item => {
            const row = tbody.insertRow();
            row.innerHTML = `
                <td>${item.Word || 'N/A'}</td>
                <td>${item.FormsPipeSeparated ? item.FormsPipeSeparated.split('|').join(', ') : ''}</td>
                <td>${new Date(item.UpdatedAt).toLocaleDateString()}</td>
                <td><button class="delete-btn" data-uuid="${item.UUID}">Delete</button></td>
            `;
            row.querySelector('.delete-btn').addEventListener('click', () => this.handleDelete(item.UUID));
        });
        container.appendChild(table);
    }

    renderPagination() {
        const container = this.shadowRoot.getElementById('pagination-container');
        container.innerHTML = '';
        const totalPages = Math.ceil(this.totalItems / this.itemsPerPage);

        if (totalPages <= 1) return;

        const prevButton = document.createElement('button');
        prevButton.textContent = 'Previous';
        prevButton.disabled = this.currentPage === 1;
        prevButton.addEventListener('click', () => this.fetchData(this.currentPage - 1, this.searchTerm));
        container.appendChild(prevButton);

        const pageInfo = document.createElement('span');
        pageInfo.textContent = `Page ${this.currentPage} of ${totalPages}`;
        container.appendChild(pageInfo);

        const nextButton = document.createElement('button');
        nextButton.textContent = 'Next';
        nextButton.disabled = this.currentPage === totalPages;
        nextButton.addEventListener('click', () => this.fetchData(this.currentPage + 1, this.searchTerm));
        container.appendChild(nextButton);
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
            // Optionally show a success message
            this.fetchData(this.currentPage, this.searchTerm); // Refresh data
        } catch (error) {
            console.error('Delete error:', error);
            alert(`Error deleting word: ${error.message}`);
        }
    }

    reloadData() {
        this.shadowRoot.getElementById('search-input').value = ''; // Clear search input
        this.fetchData(1, ''); // Reset to first page and clear search term
    }
}
customElements.define('words-table-component', WordsTableComponent);