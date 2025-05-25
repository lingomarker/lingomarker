package database

import (
	"database/sql"
	"errors"
	"fmt"
	"lingomarker/internal/models"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "github.com/mattn/go-sqlite3" // SQLite driver
)

type DB struct {
	*sql.DB
}

func InitDB(dataSourceName string) (*DB, error) {
	// Ensure the directory exists
	dir := filepath.Dir(dataSourceName)
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		if err := os.MkdirAll(dir, 0750); err != nil {
			return nil, fmt.Errorf("failed to create database directory %s: %w", dir, err)
		}
	} else if err != nil {
		return nil, fmt.Errorf("failed to check database directory %s: %w", dir, err)
	}

	db, err := sql.Open("sqlite3", dataSourceName+"?_foreign_keys=on") // Enable foreign keys
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	if err = db.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	if err = createSchema(db); err != nil {
		return nil, fmt.Errorf("failed to create schema: %w", err)
	}

	log.Println("Database initialized successfully.")
	return &DB{db}, nil
}

func createSchema(db *sql.DB) error {
	schema := `
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS user_sessions (
            session_id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            expiry DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions(expiry);

				CREATE TABLE IF NOT EXISTS user_settings (
						user_id INTEGER PRIMARY KEY,
						gemini_api_key TEXT,
						dict_base_url TEXT DEFAULT 'https://slovniky.lingea.sk/anglicko-slovensky/', -- New with default
						allow_fragment_url_list TEXT DEFAULT 'https://www.nytimes.com/,https://developer.mozilla.org/', -- New, comma-separated default
						words_number_limit INTEGER DEFAULT 4,  -- New with default
						words_length_limit INTEGER DEFAULT 50, -- New with default
						highlight_color TEXT DEFAULT 'rgba(210, 210, 10, 0.4)', -- New with default
						updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
						FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
				);

        CREATE TABLE IF NOT EXISTS entries (
            uuid TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            word TEXT NOT NULL,
            forms_pipe_separated TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, uuid), -- Composite key: entry UUID is unique per user
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_entries_user_word ON entries(user_id, word);

        CREATE TABLE IF NOT EXISTS urls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            url_hash TEXT NOT NULL,
            url TEXT NOT NULL,
            title TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (user_id, url_hash),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS paragraphs (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             user_id INTEGER NOT NULL,
             paragraph_hash TEXT NOT NULL,
             text TEXT NOT NULL,
             created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
             UNIQUE (user_id, paragraph_hash),
             FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS relations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            entry_uuid TEXT NOT NULL,
            url_hash TEXT NOT NULL,
            paragraph_hash TEXT NOT NULL,
						transcript_segment_ref TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (user_id, entry_uuid, url_hash, paragraph_hash), -- Ensure unique relation per user
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id, entry_uuid) REFERENCES entries(user_id, uuid) ON DELETE CASCADE
            -- No FK constraints on url_hash/paragraph_hash to allow flexibility, handled in logic
            -- Can add them if strict referential integrity is needed, but requires URL/Paragraph to exist first.
            -- FOREIGN KEY (user_id, url_hash) REFERENCES urls(user_id, url_hash) ON DELETE CASCADE,
            -- FOREIGN KEY (user_id, paragraph_hash) REFERENCES paragraphs(user_id, paragraph_hash) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_relations_user_entry ON relations(user_id, entry_uuid);
        CREATE INDEX IF NOT EXISTS idx_relations_user_updated ON relations(user_id, updated_at);
				CREATE INDEX IF NOT EXISTS idx_relations_transcript_segment_ref ON relations(transcript_segment_ref);

				CREATE TABLE IF NOT EXISTS podcasts (
        id TEXT PRIMARY KEY,                        -- UUID v4
        user_id INTEGER NOT NULL,
        filename TEXT NOT NULL,                     -- Original filename from upload
        store_path TEXT UNIQUE NOT NULL,            -- Relative path on server filesystem
        producer TEXT NOT NULL,
        series TEXT NOT NULL,
        episode TEXT NOT NULL,
        description TEXT,                           -- Optional episode description
        original_transcript TEXT,                   -- Optional provided transcript
        final_transcript TEXT,                      -- Generated JSON transcript (nullable initially)
        upload_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT NOT NULL DEFAULT 'uploaded' CHECK(status IN ('uploaded', 'transcribing', 'completed', 'failed')),
        error_message TEXT,                         -- Store error message on failure (New)
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
				CREATE INDEX IF NOT EXISTS idx_podcasts_user_status ON podcasts(user_id, status);
				CREATE INDEX IF NOT EXISTS idx_podcasts_user_upload_time ON podcasts(user_id, upload_time);

        `
	_, err := db.Exec(schema)
	return err
}

// --- User Methods ---

func (db *DB) CreateUser(name, username, passwordHash string) (int64, error) {
	res, err := db.Exec("INSERT INTO users (name, username, password_hash) VALUES (?, ?, ?)", name, username, passwordHash)
	if err != nil {
		// Consider checking for UNIQUE constraint violation specifically
		return 0, err
	}
	return res.LastInsertId()
}

func (db *DB) GetUserByUsername(username string) (*models.User, error) {
	user := &models.User{}
	err := db.QueryRow("SELECT id, name, username, password_hash FROM users WHERE username = ?", username).Scan(&user.ID, &user.Name, &user.Username, &user.PasswordHash)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil // User not found is not necessarily an application error
		}
		return nil, err
	}
	return user, nil
}

func (db *DB) GetUserByID(userID int64) (*models.User, error) {
	user := &models.User{}
	err := db.QueryRow("SELECT id, name, username FROM users WHERE id = ?", userID).Scan(&user.ID, &user.Name, &user.Username)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil // Not found
		}
		return nil, err
	}
	return user, nil
}

// --- Session Methods ---

func (db *DB) CreateSession(sessionID string, userID int64, expiry time.Time) error {
	_, err := db.Exec("INSERT INTO user_sessions (session_id, user_id, expiry) VALUES (?, ?, ?)", sessionID, userID, expiry)
	return err
}

func (db *DB) GetUserIDFromSession(sessionID string) (int64, error) {
	var userID int64
	var expiry time.Time
	err := db.QueryRow("SELECT user_id, expiry FROM user_sessions WHERE session_id = ?", sessionID).Scan(&userID, &expiry)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, errors.New("session not found")
		}
		return 0, err
	}
	if time.Now().After(expiry) {
		// Clean up expired session (optional, could run periodically)
		// db.DeleteSession(sessionID)
		return 0, errors.New("session expired")
	}
	return userID, nil
}

func (db *DB) DeleteSession(sessionID string) error {
	_, err := db.Exec("DELETE FROM user_sessions WHERE session_id = ?", sessionID)
	return err
}

func (db *DB) DeleteExpiredSessions() (int64, error) {
	res, err := db.Exec("DELETE FROM user_sessions WHERE expiry < ?", time.Now())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// --- Settings Methods ---

func (db *DB) GetUserSettings(userID int64) (*models.UserSettings, error) {
	settings := &models.UserSettings{
		UserID: userID,
		// Set defaults in case DB fetch returns NULLs unexpectedly (schema defaults should prevent this)
		DictBaseURL:          "https://slovniky.lingea.sk/anglicko-slovensky/",
		AllowFragmentURLList: "https://www.nytimes.com/,https://developer.mozilla.org/",
		WordsNumberLimit:     4,
		WordsLengthLimit:     50,
		HighlightColor:       "rgba(210, 210, 10, 0.4)",
	}
	var geminiKey sql.NullString
	var dictUrl sql.NullString
	var fragmentList sql.NullString
	var numLimit sql.NullInt64
	var lenLimit sql.NullInt64
	var color sql.NullString

	// Select all settings fields
	query := `SELECT
							gemini_api_key, dict_base_url, allow_fragment_url_list,
							words_number_limit, words_length_limit, highlight_color
						FROM user_settings WHERE user_id = ?`

	err := db.QueryRow(query, userID).Scan(
		&geminiKey, &dictUrl, &fragmentList, &numLimit, &lenLimit, &color,
	)

	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			// No settings row exists for the user yet, return the struct with defaults.
			// The schema defaults handle DB-level, Go defaults handle missing row.
			return settings, nil
		}
		// Other database error
		return nil, fmt.Errorf("error querying user settings for user %d: %w", userID, err)
	}

	// Populate struct from DB values if they are valid
	if geminiKey.Valid {
		settings.GeminiAPIKey = geminiKey.String
	}
	if dictUrl.Valid {
		settings.DictBaseURL = dictUrl.String
	}
	if fragmentList.Valid {
		settings.AllowFragmentURLList = fragmentList.String
	}
	if numLimit.Valid {
		settings.WordsNumberLimit = int(numLimit.Int64) // Convert int64 to int
	}
	if lenLimit.Valid {
		settings.WordsLengthLimit = int(lenLimit.Int64) // Convert int64 to int
	}
	if color.Valid {
		settings.HighlightColor = color.String
	}

	return settings, nil
}

func (db *DB) SaveUserSettings(settings *models.UserSettings) error {
	// Use INSERT OR REPLACE (UPSERT) to handle both insert and update
	query := `
			INSERT INTO user_settings (
					user_id, gemini_api_key, dict_base_url, allow_fragment_url_list,
					words_number_limit, words_length_limit, highlight_color, updated_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(user_id) DO UPDATE SET
					gemini_api_key = excluded.gemini_api_key,
					dict_base_url = excluded.dict_base_url,
					allow_fragment_url_list = excluded.allow_fragment_url_list,
					words_number_limit = excluded.words_number_limit,
					words_length_limit = excluded.words_length_limit,
					highlight_color = excluded.highlight_color,
					updated_at = CURRENT_TIMESTAMP;
	`
	_, err := db.Exec(
		query,
		settings.UserID,
		settings.GeminiAPIKey, // Keep saving this field
		settings.DictBaseURL,
		settings.AllowFragmentURLList,
		settings.WordsNumberLimit,
		settings.WordsLengthLimit,
		settings.HighlightColor,
	)
	return err
}

// --- Lingo Data Methods ---

// UpsertEntry updates an existing entry or inserts a new one
func (db *DB) UpsertEntry(entry *models.Entry) error {
	_, err := db.Exec(`
            INSERT INTO entries (uuid, user_id, word, forms_pipe_separated, created_at, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, uuid) DO UPDATE SET
                word = excluded.word,
                forms_pipe_separated = excluded.forms_pipe_separated,
                updated_at = CURRENT_TIMESTAMP;
        `, entry.UUID, entry.UserID, entry.Word, entry.FormsPipeSeparated)
	return err
}

// GetEntryByUUID retrieves a single entry for a user
func (db *DB) GetEntryByUUID(userID int64, uuid string) (*models.Entry, error) {
	entry := &models.Entry{}
	err := db.QueryRow(`
             SELECT uuid, user_id, word, forms_pipe_separated, created_at, updated_at
             FROM entries
             WHERE user_id = ? AND uuid = ?
         `, userID, uuid).Scan(
		&entry.UUID, &entry.UserID, &entry.Word, &entry.FormsPipeSeparated, &entry.CreatedAt, &entry.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil // Not found
		}
		return nil, err
	}
	return entry, nil
}

// UpsertURL adds a URL if the hash doesn't exist for the user
func (db *DB) UpsertURL(url *models.URL) error {
	_, err := db.Exec(`
            INSERT INTO urls (user_id, url_hash, url, title, created_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, url_hash) DO NOTHING;
        `, url.UserID, url.URLHash, url.URL, url.Title)
	return err
}

// UpsertParagraph adds a paragraph if the hash doesn't exist for the user
func (db *DB) UpsertParagraph(para *models.Paragraph) error {
	_, err := db.Exec(`
            INSERT INTO paragraphs (user_id, paragraph_hash, text, created_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, paragraph_hash) DO NOTHING;
        `, para.UserID, para.ParagraphHash, para.Text)
	return err
}

// UpsertRelation updates the timestamp or inserts a new relation
func (db *DB) UpsertRelation(rel *models.Relation) error {
	_, err := db.Exec(`
       INSERT INTO relations (user_id, entry_uuid, url_hash, paragraph_hash, transcript_segment_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, entry_uuid, url_hash, paragraph_hash) DO UPDATE SET
           transcript_segment_ref = excluded.transcript_segment_ref, -- Update if provided
           updated_at = CURRENT_TIMESTAMP;
   `, rel.UserID, rel.EntryUUID, rel.URLHash, rel.ParagraphHash, rel.TranscriptSegmentRef) // Added rel.TranscriptSegmentRef
	return err
}

// DeleteEntryAndRelations removes an entry and its associated relations for a user
func (db *DB) DeleteEntryAndRelations(userID int64, entryUUID string) error {
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback() // Rollback if commit fails or panics

	// 1. Get all url_hash and paragraph_hash associated with the entry's relations before deleting them.
	//    These are candidates for cleanup if they become orphaned.
	var orphanedCandidates []struct {
		URLHash       string
		ParagraphHash string
	}
	candidateRows, err := tx.Query(`
		SELECT DISTINCT url_hash, paragraph_hash
		FROM relations
		WHERE user_id = ? AND entry_uuid = ?
	`, userID, entryUUID)
	if err != nil {
		return fmt.Errorf("failed to query relations for cleanup candidates: %w", err)
	}
	for candidateRows.Next() {
		var candidate struct{ URLHash, ParagraphHash string }
		if err := candidateRows.Scan(&candidate.URLHash, &candidate.ParagraphHash); err != nil {
			candidateRows.Close()
			return fmt.Errorf("failed to scan cleanup candidate: %w", err)
		}
		orphanedCandidates = append(orphanedCandidates, candidate)
	}
	candidateRows.Close()
	if err = candidateRows.Err(); err != nil {
		return fmt.Errorf("error iterating cleanup candidates: %w", err)
	}

	// 2. Delete relations associated with the entry.
	_, err = tx.Exec("DELETE FROM relations WHERE user_id = ? AND entry_uuid = ?", userID, entryUUID)
	if err != nil {
		return fmt.Errorf("failed to delete relations: %w", err)
	}

	// 3. Delete the entry itself.
	res, err := tx.Exec("DELETE FROM entries WHERE user_id = ? AND uuid = ?", userID, entryUUID)
	if err != nil {
		return fmt.Errorf("failed to delete entry: %w", err)
	}

	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		// Optional: Return an error or log if the entry didn't exist
		log.Printf("Warning: Attempted to delete non-existent entry (UUID: %s) for user %d", entryUUID, userID)
		// If the entry didn't exist, orphanedCandidates would be empty, so no cleanup needed.
		// The transaction can be committed.
	}

	// 4. Clean up orphaned URLs and Paragraphs.
	//    For each candidate, check if it's still referenced by any *other* relation for this user.
	processedURLHashes := make(map[string]bool)
	processedParagraphHashes := make(map[string]bool)

	for _, candidate := range orphanedCandidates {
		// Cleanup URL if not already processed and if it's no longer referenced.
		if !processedURLHashes[candidate.URLHash] {
			var count int
			err = tx.QueryRow(`SELECT COUNT(*) FROM relations WHERE user_id = ? AND url_hash = ?`, userID, candidate.URLHash).Scan(&count)
			if err != nil {
				return fmt.Errorf("failed to check remaining relations for url_hash %s: %w", candidate.URLHash, err)
			}
			if count == 0 {
				_, err = tx.Exec("DELETE FROM urls WHERE user_id = ? AND url_hash = ?", userID, candidate.URLHash)
				if err != nil {
					return fmt.Errorf("failed to delete orphaned url %s: %w", candidate.URLHash, err)
				}
				log.Printf("Cleaned up orphaned URL (Hash: %s) for user %d", candidate.URLHash, userID)
			}
			processedURLHashes[candidate.URLHash] = true
		}

		// Cleanup Paragraph if not already processed and if it's no longer referenced.
		if !processedParagraphHashes[candidate.ParagraphHash] {
			var count int
			err = tx.QueryRow(`SELECT COUNT(*) FROM relations WHERE user_id = ? AND paragraph_hash = ?`, userID, candidate.ParagraphHash).Scan(&count)
			if err != nil {
				return fmt.Errorf("failed to check remaining relations for paragraph_hash %s: %w", candidate.ParagraphHash, err)
			}
			if count == 0 {
				_, err = tx.Exec("DELETE FROM paragraphs WHERE user_id = ? AND paragraph_hash = ?", userID, candidate.ParagraphHash)
				if err != nil {
					return fmt.Errorf("failed to delete orphaned paragraph %s: %w", candidate.ParagraphHash, err)
				}
				log.Printf("Cleaned up orphaned Paragraph (Hash: %s) for user %d", candidate.ParagraphHash, userID)
			}
			processedParagraphHashes[candidate.ParagraphHash] = true
		}
	}

	return tx.Commit() // Commit the transaction
}

// GetUserDataBundle retrieves all necessary data (words a.k.a. entries) for the UserScript highlighting
func (db *DB) GetUserDataBundle(userID int64) (*models.UserDataBundle, error) {
	bundle := &models.UserDataBundle{
		Entries:    make([]models.Entry, 0),
		URLs:       make([]models.URL, 0),
		Paragraphs: make([]models.Paragraph, 0),
		Relations:  make([]models.Relation, 0),
	}

	// Get Entries
	rows, err := db.Query(`
               SELECT uuid, word, forms_pipe_separated, created_at, updated_at
               FROM entries WHERE user_id = ?
           `, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to query entries: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		e := models.Entry{UserID: userID}
		if err := rows.Scan(&e.UUID, &e.Word, &e.FormsPipeSeparated, &e.CreatedAt, &e.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan entry: %w", err)
		}
		bundle.Entries = append(bundle.Entries, e)
	}
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating entry rows: %w", err)
	}

	// Get All URLs associated with the user
	rows, err = db.Query(`
               SELECT url_hash, url, title, created_at
               FROM urls WHERE user_id = ?
           `, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to query urls: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		u := models.URL{UserID: userID}
		if err := rows.Scan(&u.URLHash, &u.URL, &u.Title, &u.CreatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan url: %w", err)
		}
		bundle.URLs = append(bundle.URLs, u)
	}
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating url rows: %w", err)
	}

	// Get All Paragraphs associated with the user
	rows, err = db.Query(`
               SELECT paragraph_hash, text, created_at
               FROM paragraphs WHERE user_id = ?
           `, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to query paragraphs: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		p := models.Paragraph{UserID: userID}
		if err := rows.Scan(&p.ParagraphHash, &p.Text, &p.CreatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan paragraph: %w", err)
		}
		bundle.Paragraphs = append(bundle.Paragraphs, p)
	}
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating paragraph rows: %w", err)
	}

	// Get Relations
	rows, err = db.Query(`
        SELECT entry_uuid, url_hash, paragraph_hash, transcript_segment_ref, created_at, updated_at
        FROM relations WHERE user_id = ?
    `, userID)
	if err != nil { /* ... error handling ... */
	}
	defer rows.Close()
	for rows.Next() {
		r := models.Relation{UserID: userID}
		// Add a nullable string for transcript_segment_ref
		var tsRef sql.NullString
		if err := rows.Scan(&r.EntryUUID, &r.URLHash, &r.ParagraphHash, &tsRef, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan relation: %w", err)
		}
		if tsRef.Valid {
			r.TranscriptSegmentRef = &tsRef.String
		}
		bundle.Relations = append(bundle.Relations, r)
	}
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating relation rows: %w", err)
	}

	return bundle, nil
}

// GetTrainingData retrieves data formatted for the training page, sorted by recent interaction
func (db *DB) GetTrainingData(userID int64, limit int) ([]models.TrainingItem, error) {
	items := make([]models.TrainingItem, 0, limit)
	// Select distinct relations, join with other tables, order by relation updated_at desc
	query := `
            SELECT DISTINCT r.updated_at, u.url, u.title, p.text, e.word
            FROM relations r
            JOIN entries e ON r.user_id = e.user_id AND r.entry_uuid = e.uuid
            LEFT JOIN urls u ON r.user_id = u.user_id AND r.url_hash = u.url_hash
            LEFT JOIN paragraphs p ON r.user_id = p.user_id AND r.paragraph_hash = p.paragraph_hash
            WHERE r.user_id = ?
            ORDER BY r.updated_at DESC
            LIMIT ?;
            `
	// Note: The DISTINCT here might not be exactly what the original userscript did,
	// which seemed to group by paragraph/url first. This gets the most recently interacted *relations*.
	// Adjust the query if the grouping logic needs to be exactly replicated.

	rows, err := db.Query(query, userID, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to query training data: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		item := models.TrainingItem{}
		var url sql.NullString
		var title sql.NullString
		var paragraph sql.NullString
		var word sql.NullString // Base word

		if err := rows.Scan(&item.UpdatedAt, &url, &title, &paragraph, &word); err != nil {
			return nil, fmt.Errorf("failed to scan training item: %w", err)
		}

		if url.Valid {
			item.URL = url.String
		}
		if title.Valid {
			item.Title = &title.String
		}
		if paragraph.Valid {
			item.Paragraph = paragraph.String
		} else if word.Valid {
			// Fallback to just the word if paragraph is missing (as in original script)
			item.Paragraph = word.String
		}
		if word.Valid {
			item.Word = word.String
		}

		items = append(items, item)
	}
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating training data rows: %w", err)
	}

	return items, nil
}

// --- Bulk Import Method ---
// ImportData imports data from the old UserScript JSON format for a specific user
// NOTE: This is a basic implementation. Error handling and duplicate management might need refinement.
func (db *DB) ImportData(userID int64, data map[string]map[string][]string) (int, int, int, int, error) {
	importedEntries := 0
	importedUrls := 0
	importedParagraphs := 0
	importedRelations := 0

	tx, err := db.Begin()
	if err != nil {
		return 0, 0, 0, 0, fmt.Errorf("import: failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	// Assuming only one dictionary key exists or we process the first one found
	var dictData map[string][]string
	for _, v := range data {
		dictData = v
		break
	}
	if dictData == nil {
		return 0, 0, 0, 0, errors.New("import: no dictionary data found in JSON")
	}

	// Import Entries first
	entriesMap := make(map[string]string) // uuid -> word forms
	for _, entryStr := range dictData["entries"] {
		parts := strings.SplitN(entryStr, "|", 2)
		if len(parts) == 2 {
			uuid := parts[0]
			forms := parts[1]
			word := strings.Split(forms, "|")[0] // Assume first form is base word

			_, err := tx.Exec(`
                        INSERT INTO entries (uuid, user_id, word, forms_pipe_separated, created_at, updated_at)
                        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                        ON CONFLICT(user_id, uuid) DO NOTHING;
                    `, uuid, userID, word, forms)
			if err != nil {
				log.Printf("Import warning: Failed to insert entry %s: %v", uuid, err)
				continue // Skip this entry
			}
			entriesMap[uuid] = forms // Keep track for relation import
			importedEntries++
		} else {
			log.Printf("Import warning: Malformed entry string: %s", entryStr)
		}
	}

	// Import URLs
	urlsMap := make(map[string]string) // hash -> url
	for _, urlStr := range dictData["urls"] {
		parts := strings.SplitN(urlStr, "|", 3)
		if len(parts) >= 2 {
			hash := parts[0]
			url := parts[1]
			var title *string
			if len(parts) == 3 && len(parts[2]) > 0 {
				title = &parts[2]
			}
			_, err := tx.Exec(`
                        INSERT INTO urls (user_id, url_hash, url, title, created_at)
                        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                        ON CONFLICT(user_id, url_hash) DO NOTHING;
                     `, userID, hash, url, title)
			if err != nil {
				log.Printf("Import warning: Failed to insert URL %s: %v", hash, err)
				continue
			}
			urlsMap[hash] = url
			importedUrls++
		} else {
			log.Printf("Import warning: Malformed URL string: %s", urlStr)
		}
	}

	// Import Paragraphs
	paragraphsMap := make(map[string]string) // hash -> text
	for _, paraStr := range dictData["paragraphs"] {
		parts := strings.SplitN(paraStr, "|", 2)
		if len(parts) == 2 {
			hash := parts[0]
			text := parts[1]
			_, err := tx.Exec(`
                        INSERT INTO paragraphs (user_id, paragraph_hash, text, created_at)
                        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                        ON CONFLICT(user_id, paragraph_hash) DO NOTHING;
                     `, userID, hash, text)
			if err != nil {
				log.Printf("Import warning: Failed to insert paragraph %s: %v", hash, err)
				continue
			}
			paragraphsMap[hash] = text
			importedParagraphs++
		} else {
			log.Printf("Import warning: Malformed paragraph string: %s", paraStr)
		}
	}

	// Import Relations
	for _, relStr := range dictData["relations"] {
		parts := strings.SplitN(relStr, "|", 4)
		if len(parts) == 4 {
			tsStr := parts[0]
			entryUUID := parts[1]
			urlHash := parts[2]
			paraHash := parts[3]

			// Convert timestamp (milliseconds string)
			tsMillis, err := strconv.ParseInt(tsStr, 10, 64)
			if err != nil {
				log.Printf("Import warning: Invalid timestamp in relation %s: %v", relStr, err)
				continue
			}
			relTime := time.UnixMilli(tsMillis)

			// Check if referenced items were successfully imported (optional but good practice)
			if _, ok := entriesMap[entryUUID]; !ok {
				log.Printf("Import warning: Skipping relation, missing entry %s", entryUUID)
				continue
			}
			if _, ok := urlsMap[urlHash]; !ok {
				log.Printf("Import warning: Skipping relation, missing url %s", urlHash)
				continue
			}
			if _, ok := paragraphsMap[paraHash]; !ok {
				log.Printf("Import warning: Skipping relation, missing paragraph %s", paraHash)
				continue
			}

			_, err = tx.Exec(`
                        INSERT INTO relations (user_id, entry_uuid, url_hash, paragraph_hash, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT(user_id, entry_uuid, url_hash, paragraph_hash) DO UPDATE SET
                            updated_at = excluded.updated_at; -- Update timestamp if newer
                    `, userID, entryUUID, urlHash, paraHash, relTime, relTime) // Use imported time for both initially
			if err != nil {
				log.Printf("Import warning: Failed to insert relation %s: %v", relStr, err)
				continue
			}
			importedRelations++
		} else {
			log.Printf("Import warning: Malformed relation string: %s", relStr)
		}
	}

	err = tx.Commit()
	if err != nil {
		return 0, 0, 0, 0, fmt.Errorf("import: failed to commit transaction: %w", err)
	}

	log.Printf("Import successful for user %d: Entries=%d, URLs=%d, Paragraphs=%d, Relations=%d",
		userID, importedEntries, importedUrls, importedParagraphs, importedRelations)
	return importedEntries, importedUrls, importedParagraphs, importedRelations, nil
}

// CreatePodcastRecord inserts initial podcast metadata into the DB.
func (db *DB) CreatePodcastRecord(p *models.Podcast) error {
	_, err := db.Exec(`
        INSERT INTO podcasts (id, user_id, filename, store_path, producer, series, episode, description, original_transcript, status, upload_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		p.ID, p.UserID, p.Filename, p.StorePath, p.Producer, p.Series, p.Episode, p.Description, p.OriginalTranscript, p.Status, p.UploadTime,
	)
	if err != nil {
		// Check for UNIQUE constraint violation on store_path explicitly if needed
		return fmt.Errorf("failed to insert podcast record %s: %w", p.ID, err)
	}
	return nil
}

// UpdatePodcastStatus updates only the status and error message of a podcast record.
func (db *DB) UpdatePodcastStatus(userID int64, podcastID string, status models.PodcastStatus, errMsg *string) error {
	res, err := db.Exec(`
        UPDATE podcasts SET status = ?, error_message = ?, upload_time = upload_time -- Keep original upload time
        WHERE id = ? AND user_id = ?`,
		status, errMsg, podcastID, userID,
	)
	if err != nil {
		return fmt.Errorf("failed to update status for podcast %s: %w", podcastID, err)
	}
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		return fmt.Errorf("podcast %s not found for user %d or status unchanged", podcastID, userID)
	}
	return nil
}

// UpdatePodcastTranscript updates the final transcript, status, and error message.
func (db *DB) UpdatePodcastTranscript(userID int64, podcastID string, finalTranscript *string, status models.PodcastStatus, errMsg *string) error {
	res, err := db.Exec(`
		UPDATE podcasts SET final_transcript = ?, status = ?, error_message = ?, upload_time = upload_time
		WHERE id = ? AND user_id = ?`,
		finalTranscript, status, errMsg, podcastID, userID,
	)
	if err != nil {
		return fmt.Errorf("failed to update transcript for podcast %s: %w", podcastID, err)
	}
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		return fmt.Errorf("podcast %s not found for user %d or transcript unchanged", podcastID, userID)
	}
	return nil
}

// GetPodcastStorePath retrieves the storage path for transcription.
func (db *DB) GetPodcastStorePath(userID int64, podcastID string) (string, error) {
	var storePath string
	err := db.QueryRow("SELECT store_path FROM podcasts WHERE id = ? AND user_id = ?", podcastID, userID).Scan(&storePath)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", fmt.Errorf("podcast %s not found for user %d", podcastID, userID)
		}
		return "", fmt.Errorf("failed to query store path for podcast %s: %w", podcastID, err)
	}
	return storePath, nil
}

// ListPodcastsByUser retrieves a list of podcasts for a user, ordered by upload time descending.
func (db *DB) ListPodcastsByUser(userID int64, limit, offset int) ([]models.PodcastListItem, error) {
	// Ensure limit is reasonable
	if limit <= 0 || limit > 200 {
		limit = 50 // Default/max limit
	}
	if offset < 0 {
		offset = 0
	}

	query := `
        SELECT id, producer, series, episode, upload_time, status
        FROM podcasts
        WHERE user_id = ?
        ORDER BY upload_time DESC
        LIMIT ? OFFSET ?
    `
	rows, err := db.Query(query, userID, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("failed to query podcasts for user %d: %w", userID, err)
	}
	defer rows.Close()

	podcasts := make([]models.PodcastListItem, 0)
	for rows.Next() {
		var p models.PodcastListItem
		if err := rows.Scan(&p.ID, &p.Producer, &p.Series, &p.Episode, &p.UploadTime, &p.Status); err != nil {
			// Log error but continue processing other rows? Or return immediately?
			log.Printf("Error scanning podcast row for user %d: %v", userID, err)
			continue // Skip problematic row
		}
		podcasts = append(podcasts, p)
	}
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating podcast rows for user %d: %w", userID, err)
	}

	return podcasts, nil
}

// DeletePodcastRecord removes a podcast record and its associated file.
// Returns the store_path of the deleted file or an error.
func (db *DB) DeletePodcastRecord(userID int64, podcastID string) (string, error) {
	var storePath string
	// Begin transaction to ensure atomicity
	tx, err := db.Begin()
	if err != nil {
		return "", fmt.Errorf("failed to begin transaction for podcast deletion: %w", err)
	}
	defer tx.Rollback() // Rollback if anything fails

	// Get the store path first within the transaction
	err = tx.QueryRow("SELECT store_path FROM podcasts WHERE id = ? AND user_id = ?", podcastID, userID).Scan(&storePath)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", fmt.Errorf("podcast %s not found for user %d", podcastID, userID) // Specific not found error
		}
		return "", fmt.Errorf("failed to query store path for podcast %s: %w", podcastID, err)
	}

	// Delete the record from the database within the transaction
	res, err := tx.Exec("DELETE FROM podcasts WHERE id = ? AND user_id = ?", podcastID, userID)
	if err != nil {
		return storePath, fmt.Errorf("failed to delete podcast record %s: %w", podcastID, err)
	}

	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		// Should have been caught by the QueryRow earlier, but double-check
		return storePath, fmt.Errorf("podcast %s not found during delete for user %d", podcastID, userID)
	}

	// Store path example: uploads/1/7e9010e5-d6f1-4284-8068-79c4617965cc.mp3
	filename := filepath.Base(storePath)
	filenameWithoutExt := strings.TrimSuffix(filename, filepath.Ext(filename))

	var urlHash string
	// Get url_hash from the urls table
	err = tx.QueryRow("SELECT url_hash FROM urls WHERE user_id = ? AND url LIKE '%' || ? || '%'", userID, filenameWithoutExt).Scan(&urlHash)
	if err != nil && err.Error() != "sql: no rows in result set" {
		return storePath, fmt.Errorf("failed to query url_hash for podcast %s: %w", podcastID, err)
	}

	if urlHash != "" {
		rows, err := tx.Query("SELECT paragraph_hash FROM relations WHERE user_id = ? AND url_hash = ?", userID, urlHash)
		if err != nil {
			return storePath, fmt.Errorf("failed to query relations for podcast %s: %w", podcastID, err)
		}
		defer rows.Close()

		for rows.Next() {
			r := models.Relation{}
			if err := rows.Scan(&r.ParagraphHash); err != nil {
				return storePath, fmt.Errorf("failed to scan relation: %w", err)
			}
			// Delete from the paragraphs table
			_, err = tx.Exec("DELETE FROM paragraphs WHERE user_id = ? AND paragraph_hash = ?", userID, r.ParagraphHash)
			if err != nil {
				return storePath, fmt.Errorf("failed to delete paragraphs for podcast %s: %w", podcastID, err)
			}
		}

		// Delete from the urls table
		_, err = tx.Exec("DELETE FROM urls WHERE user_id = ? AND url_hash = ?", userID, urlHash)
		if err != nil {
			return storePath, fmt.Errorf("failed to delete urls for podcast %s: %w", podcastID, err)
		}
	}

	// Delete from the relations table
	_, err = tx.Exec("DELETE FROM relations WHERE user_id = ? AND url_hash = ?", userID, urlHash)
	if err != nil {
		return storePath, fmt.Errorf("failed to delete relations for podcast %s: %w", podcastID, err)
	}

	// Commit the transaction *before* attempting file deletion
	if err := tx.Commit(); err != nil {
		return storePath, fmt.Errorf("failed to commit transaction for podcast deletion: %w", err)
	}

	// Return the path so the handler can delete the file *after* successful DB commit
	return storePath, nil
}

// GetPodcastByIDForUser retrieves a single podcast record for a user, including full transcripts.
func (db *DB) GetPodcastByIDForUser(userID int64, podcastID string) (*models.Podcast, error) {
	query := `
        SELECT id, user_id, filename, store_path, producer, series, episode, description,
               original_transcript, final_transcript, upload_time, status, error_message
        FROM podcasts
        WHERE id = ? AND user_id = ?
    `
	p := &models.Podcast{}
	var desc sql.NullString
	var origTranscript sql.NullString
	var finalTranscript sql.NullString
	var errMsg sql.NullString

	err := db.QueryRow(query, podcastID, userID).Scan(
		&p.ID, &p.UserID, &p.Filename, &p.StorePath, &p.Producer, &p.Series, &p.Episode, &desc,
		&origTranscript, &finalTranscript, &p.UploadTime, &p.Status, &errMsg,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("podcast %s not found for user %d", podcastID, userID)
		}
		return nil, fmt.Errorf("failed to query podcast %s for user %d: %w", podcastID, userID, err)
	}

	if desc.Valid {
		p.Description = &desc.String
	}
	if origTranscript.Valid {
		p.OriginalTranscript = &origTranscript.String
	}
	if finalTranscript.Valid {
		p.FinalTranscript = &finalTranscript.String
	}
	if errMsg.Valid {
		p.ErrorMessage = &errMsg.String
	}

	return p, nil
}

type Timestamp time.Time

func (p *Timestamp) Scan(value any) error {
	// t := value.(time.Time)
	t, err := time.Parse("2006-01-02 15:04:05", value.(string))
	if err != nil {
		log.Printf("Error converting string '%s' "+"to time.Time: %v", value, err)
		t = time.Time{} // Default to zero time on error
	}
	*p = Timestamp(t)
	return nil
}

// GetReviewPageData fetches data structured for the review page.
// It gets distinct sources (articles or podcasts) based on recent interactions,
// then fetches all related paragraphs for those sources.
func (db *DB) GetReviewPageData(userID int64, limit int) ([]models.ReviewSource, error) {
	if limit <= 0 {
		limit = 50
	}

	// Step 1: Get the 'limit' most recently interacted-with unique 'url_hash' values (sources).
	// This query determines the *order* of sources on the review page.
	sourceOrderQuery := `
        SELECT
            r.url_hash,
            MAX(r.updated_at) as max_updated_at
        FROM relations r
        WHERE r.user_id = ?
        GROUP BY r.url_hash
        ORDER BY max_updated_at DESC
        LIMIT ?;
    `
	sourceOrderRows, err := db.Query(sourceOrderQuery, userID, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to query source order for review page (user %d): %w", userID, err)
	}
	defer sourceOrderRows.Close()

	var orderedUrlHashes []string
	sourceMaxUpdateTimes := make(map[string]time.Time) // url_hash -> max_updated_at

	for sourceOrderRows.Next() {
		var urlHash string
		var maxUpdatedAt Timestamp // Use your custom Timestamp type
		if err := sourceOrderRows.Scan(&urlHash, &maxUpdatedAt); err != nil {
			log.Printf("Error scanning source order row for user %d: %v", userID, err)
			continue
		}
		orderedUrlHashes = append(orderedUrlHashes, urlHash)
		sourceMaxUpdateTimes[urlHash] = time.Time(maxUpdatedAt)
	}
	if err = sourceOrderRows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating source order rows for user %d: %w", userID, err)
	}
	sourceOrderRows.Close() // Close explicitly before next query

	if len(orderedUrlHashes) == 0 {
		return []models.ReviewSource{}, nil
	}

	// Step 2: Fetch details for these ordered sources (article/podcast info) and their distinct paragraphs.
	// Construct IN clause for url_hashes
	urlHashesForInClause := make([]interface{}, len(orderedUrlHashes))
	for i, h := range orderedUrlHashes {
		urlHashesForInClause[i] = h
	}
	placeholders := strings.Repeat("?,", len(orderedUrlHashes)-1) + "?"

	// Query to get source details (from urls/podcasts) AND distinct paragraphs for these sources
	// We use a subquery to get distinct paragraphs per url_hash, ordered by their own recency if desired
	// or just any transcript_segment_ref if multiple words in same paragraph point to different segments (less likely).
	// For podcast paragraphs, we need the transcript_segment_ref. We'll pick one if multiple relations point to the same paragraph.
	// It's simpler to get all paragraphs per source and then the latest transcript_segment_ref for those that are segments.

	// This query fetches all necessary data in a more structured way to avoid N+1 problems later.
	// It joins relations with paragraphs, then with urls, and then with podcasts.
	// The GROUP BY url_hash, paragraph_hash ensures we get distinct paragraphs per source.
	// We take MAX(transcript_segment_ref) as a simple way to get *a* ref if multiple exist for the same paragraph.
	// MAX(r.updated_at) per paragraph could be used to sort paragraphs within a source, but natural order might be better.
	reviewDataQuery := fmt.Sprintf(`
        SELECT
            r.url_hash,
            p_text.text as paragraph_text,
            r.paragraph_hash,
            MAX(r.transcript_segment_ref) as transcript_segment_ref, -- Get one segment ref if multiple
            CASE WHEN MAX(r.transcript_segment_ref) IS NOT NULL AND MAX(r.transcript_segment_ref) != '' THEN 1 ELSE 0 END as is_podcast_segment,
            u.url as article_url,
            u.title as article_title,
            pod.id as podcast_id,
            pod.producer as podcast_producer,
            pod.series as podcast_series,
            pod.episode as podcast_episode
            -- Add r.updated_at here if you want to sort paragraphs by their last interaction
            -- ORDER BY r.url_hash, r.updated_at DESC -- Example for sorting paragraphs within source
        FROM relations r
        JOIN paragraphs p_text ON r.user_id = p_text.user_id AND r.paragraph_hash = p_text.paragraph_hash
        LEFT JOIN urls u ON r.user_id = u.user_id AND r.url_hash = u.url_hash
        LEFT JOIN podcasts pod ON u.user_id = pod.user_id AND INSTR(u.url, pod.id) > 0 -- Heuristic
        WHERE r.user_id = ? AND r.url_hash IN (%s)
        GROUP BY r.url_hash, r.paragraph_hash -- This ensures distinct paragraphs per source
        ORDER BY r.url_hash, MAX(r.updated_at) DESC -- MIN(p_text.id) -- Attempt to maintain paragraph original order if possible (by paragraph ID)
                                          -- Or use MAX(r.updated_at) here to sort paragraphs by recent interaction
        ;																					
    `, placeholders)

	allDataRows, err := db.Query(reviewDataQuery, append([]interface{}{userID}, urlHashesForInClause...)...)
	if err != nil {
		return nil, fmt.Errorf("failed to query review data details for user %d: %w", userID, err)
	}
	defer allDataRows.Close()

	// Temporary map to aggregate paragraphs under their source (url_hash)
	aggregatedSources := make(map[string]*models.ReviewSource)

	for allDataRows.Next() {
		var urlHash, paragraphText, paragraphHash string
		var transcriptSegmentRef sql.NullString
		var isPodcastSegment bool
		var articleURL, articleTitle sql.NullString
		var podcastID, podcastProducer, podcastSeries, podcastEpisode sql.NullString

		err := allDataRows.Scan(
			&urlHash, &paragraphText, &paragraphHash, &transcriptSegmentRef, &isPodcastSegment,
			&articleURL, &articleTitle,
			&podcastID, &podcastProducer, &podcastSeries, &podcastEpisode,
		)
		if err != nil {
			log.Printf("Error scanning review data row for user %d: %v", userID, err)
			continue
		}

		// If this is the first time we see this url_hash, create the ReviewSource
		if _, ok := aggregatedSources[urlHash]; !ok {
			source := &models.ReviewSource{
				SourceID:              urlHash,
				MostRecentInteraction: sourceMaxUpdateTimes[urlHash], // Get from Step 1 results
				Paragraphs:            make([]models.ReviewParagraph, 0),
			}
			if podcastID.Valid && podcastID.String != "" {
				source.SourceType = "podcast"
				source.SourceTitle = fmt.Sprintf("%s: %s - %s", podcastProducer.String, podcastSeries.String, podcastEpisode.String)
				source.SourceLink = fmt.Sprintf("/podcasts/play/%s", podcastID.String)
			} else if articleURL.Valid {
				source.SourceType = "article"
				source.SourceTitle = articleTitle.String // Will be empty string if NULL, JS handles display
				if !articleTitle.Valid || articleTitle.String == "" {
					source.SourceTitle = articleURL.String // Fallback
				}
				source.SourceLink = articleURL.String
			} else {
				source.SourceType = "unknown"
				source.SourceTitle = "Unknown Source (" + urlHash + ")"
				source.SourceLink = "#"
			}
			aggregatedSources[urlHash] = source
		}

		// Add the paragraph to this source
		reviewPara := models.ReviewParagraph{
			Text:             paragraphText,
			ParagraphHash:    paragraphHash,
			IsPodcastSegment: isPodcastSegment,
		}
		if transcriptSegmentRef.Valid {
			reviewPara.TranscriptSegmentRef = &transcriptSegmentRef.String
		}
		aggregatedSources[urlHash].Paragraphs = append(aggregatedSources[urlHash].Paragraphs, reviewPara)
	}
	if err = allDataRows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating review data rows for user %d: %w", userID, err)
	}

	// Convert map to slice, maintaining the original order from Step 1
	finalReviewSources := make([]models.ReviewSource, 0, len(orderedUrlHashes))
	for _, urlHash := range orderedUrlHashes {
		if source, ok := aggregatedSources[urlHash]; ok {
			finalReviewSources = append(finalReviewSources, *source)
		}
	}

	return finalReviewSources, nil
}
