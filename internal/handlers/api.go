package handlers

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"lingomarker/internal/config"
	"lingomarker/internal/database"
	"lingomarker/internal/models"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid" // For generating entry UUIDs server-side
)

type APIHandlers struct {
	DB  *database.DB
	Cfg *config.Config
}

// Helper to write JSON responses
func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if data != nil {
		if err := json.NewEncoder(w).Encode(data); err != nil {
			log.Printf("Error encoding JSON response: %v", err)
			// Don't try to write an error response here, headers are already sent
		}
	}
}

// Helper to write JSON error responses
func writeJSONError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

// --- API Endpoints ---

// HandleSessionCheck verifies session and returns user info + settings
func (h *APIHandlers) HandleSessionCheck(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserIDContextKey).(int64)

	user, err := h.DB.GetUserByID(userID)
	if err != nil || user == nil {
		log.Printf("API Session Check: Failed to get user %d: %v", userID, err)
		writeJSONError(w, http.StatusInternalServerError, "Failed to retrieve user data")
		return
	}

	settings, err := h.DB.GetUserSettings(userID)
	if err != nil {
		log.Printf("API Session Check: Failed to get settings for user %d: %v", userID, err)
		// Proceed without settings? Or fail? Let's fail for consistency.
		writeJSONError(w, http.StatusInternalServerError, "Failed to retrieve user settings")
		return
	}
	// Ensure settings is not nil
	if settings == nil {
		// This case should be handled by GetUserSettings now, returning defaults
		log.Printf("API Session Check: Warning - GetUserSettings returned nil for user %d", userID)
		// Create a default settings object to return
		settings = &models.UserSettings{ /* Populate with defaults if necessary */ }
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"authenticated": true,
		"userID":        userID,
		"username":      user.Username,
		"name":          user.Name,
		"settings":      settings, // Embed the user settings object
	})
}

// HandleGetData retrieves all user data for highlighting
func (h *APIHandlers) HandleGetData(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserIDContextKey).(int64)
	bundle, err := h.DB.GetUserDataBundle(userID)
	if err != nil {
		log.Printf("API GetData: Failed for user %d: %v", userID, err)
		writeJSONError(w, http.StatusInternalServerError, "Failed to retrieve user data")
		return
	}
	writeJSON(w, http.StatusOK, bundle)
}

// HandleMarkWord handles adding/updating a word selection
func (h *APIHandlers) HandleMarkWord(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserIDContextKey).(int64)

	// 1. Decode Request Body
	var req struct {
		Word          string  `json:"word"` // The selected word (lowercase)
		URL           string  `json:"url"`
		Title         *string `json:"title"`
		ParagraphText string  `json:"paragraphText"`
		URLHash       string  `json:"urlHash"`       // Pre-calculated by UserScript
		ParagraphHash string  `json:"paragraphHash"` // Pre-calculated by UserScript
		EntryUUID     *string `json:"entryUUID"`     // Optional: UUID if word already exists client-side
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "Invalid request body: "+err.Error())
		return
	}
	defer r.Body.Close()

	// Basic validation
	if req.Word == "" || req.URL == "" || req.ParagraphText == "" || req.URLHash == "" || req.ParagraphHash == "" {
		writeJSONError(w, http.StatusBadRequest, "Missing required fields (word, url, paragraphText, urlHash, paragraphHash)")
		return
	}

	// 2. Begin Transaction
	tx, err := h.DB.Begin()
	if err != nil {
		log.Printf("API MarkWord: Failed to begin transaction for user %d: %v", userID, err)
		writeJSONError(w, http.StatusInternalServerError, "Database error")
		return
	}
	// Use a custom DB struct that wraps the transaction
	/// txDB := &database.DB{DB: h.DB.DB} // Need DB for GetUserSettings etc.
	// We need helper functions in database.go that accept a *sql.Tx or similar interface

	// *** Refactor database.go required ***
	// The database methods need to accept a Querier interface (implemented by *sql.DB and *sql.Tx)
	// Or, pass the transaction explicitly. Let's pass explicitly for now.

	// Rollback helper
	rollback := func(tx *sql.Tx, msg string, err error) {
		log.Printf("%s for user %d: %v", msg, userID, err)
		if rbErr := tx.Rollback(); rbErr != nil {
			log.Printf("API MarkWord: Error rolling back transaction for user %d: %v", userID, rbErr)
		}
		writeJSONError(w, http.StatusInternalServerError, "Failed to process request")
	}

	// 3. Upsert URL and Paragraph (do this outside the main entry logic if possible)
	dbURL := &models.URL{UserID: userID, URLHash: req.URLHash, URL: req.URL, Title: req.Title}
	if err := h.DB.UpsertURL(dbURL); err != nil { // UpsertURL uses its own connection pool logic
		log.Printf("API MarkWord: Failed to upsert URL %s for user %d: %v", req.URLHash, userID, err)
		// Not necessarily fatal, maybe log and continue? Or error out? Let's error for now.
		writeJSONError(w, http.StatusInternalServerError, "Failed to save URL data")
		return
	}

	dbPara := &models.Paragraph{UserID: userID, ParagraphHash: req.ParagraphHash, Text: req.ParagraphText}
	if err := h.DB.UpsertParagraph(dbPara); err != nil { // UpsertParagraph uses its own connection pool logic
		log.Printf("API MarkWord: Failed to upsert Paragraph %s for user %d: %v", req.ParagraphHash, userID, err)
		writeJSONError(w, http.StatusInternalServerError, "Failed to save paragraph data")
		return
	}

	// 4. Find or Create Entry
	entryUUID := ""
	if req.EntryUUID != nil {
		entryUUID = *req.EntryUUID
		// Verify it exists for the user
		_, err := h.DB.GetEntryByUUID(userID, entryUUID) // Check existence
		if err != nil {
			rollback(tx, fmt.Sprintf("API MarkWord: Error verifying existing entry UUID %s", entryUUID), err)
			return
		}
		// If err is sql.ErrNoRows, treat as a new word case below
		if err == sql.ErrNoRows {
			entryUUID = "" // Force creation path
		} else if err != nil {
			// Handle other DB errors
			rollback(tx, fmt.Sprintf("API MarkWord: DB error verifying existing entry UUID %s", entryUUID), err)
			return
		}
	}

	var finalEntry *models.Entry

	if entryUUID == "" { // Word is new or UUID wasn't provided/valid
		// Generate a new UUID server-side
		entryUUID = uuid.NewString()

		// --- Call Gemini API ---
		settings, err := h.DB.GetUserSettings(userID)
		if err != nil {
			rollback(tx, "API MarkWord: Failed to get user settings", err)
			return
		}
		if settings == nil || settings.GeminiAPIKey == "" {
			rollback(tx, "API MarkWord: Gemini API key not set for user", errors.New("API key not set"))
			// Or, insert entry without forms? For now require key.
			writeJSONError(w, http.StatusPreconditionFailed, "Gemini API key not configured in settings.")
			return
		}

		wordForms, err := callGeminiForWordForms(h.Cfg, settings.GeminiAPIKey, req.Word)
		if err != nil {
			rollback(tx, "API MarkWord: Failed to get word forms from Gemini", err)
			// Return a specific error?
			writeJSONError(w, http.StatusFailedDependency, "Failed to retrieve word forms: "+err.Error())
			return
		}
		// --- End Gemini API Call ---

		newEntry := &models.Entry{
			UUID:               entryUUID,
			UserID:             userID,
			Word:               req.Word,
			FormsPipeSeparated: wordForms,
			// CreatedAt/UpdatedAt set by DB default/trigger
		}
		if err := h.DB.UpsertEntry(newEntry); err != nil { // UpsertEntry uses its own connection logic
			rollback(tx, "API MarkWord: Failed to insert new entry", err)
			return
		}
		finalEntry = newEntry
		finalEntry.CreatedAt = time.Now() // Approximate time for response
		finalEntry.UpdatedAt = time.Now()
	} else {
		// Word exists, we just need to update relation timestamp
		// Fetch the existing entry to return it
		existingEntry, err := h.DB.GetEntryByUUID(userID, entryUUID)
		if err != nil || existingEntry == nil {
			rollback(tx, fmt.Sprintf("API MarkWord: Failed to fetch existing entry %s after check", entryUUID), err)
			return
		}
		finalEntry = existingEntry
	}

	// 5. Upsert Relation (always update timestamp)
	relation := &models.Relation{
		UserID:        userID,
		EntryUUID:     entryUUID,
		URLHash:       req.URLHash,
		ParagraphHash: req.ParagraphHash,
		// CreatedAt/UpdatedAt handled by DB trigger/logic
	}
	if err := h.DB.UpsertRelation(relation); err != nil { // UpsertRelation uses its own connection logic
		rollback(tx, "API MarkWord: Failed to upsert relation", err)
		return
	}

	// 6. Commit Transaction (Only if transaction was used for entry creation logic - refactor needed)
	// Since Upserts currently handle their own connections, explicit tx commit isn't right here.
	// The Upsert logic needs refactoring to accept a *sql.Tx if we want true atomicity.
	// For now, we assume individual upserts are atomic enough.
	/*
	    if err := tx.Commit(); err != nil {
	       log.Printf("API MarkWord: Failed to commit transaction for user %d: %v", userID, err)
	       writeJSONError(w, http.StatusInternalServerError, "Database error during commit")
	       return
	   }
	*/

	// 7. Return the final Entry object (including generated UUID and forms if new)
	writeJSON(w, http.StatusOK, finalEntry)
}

// callGeminiForWordForms interacts with the Gemini API
func callGeminiForWordForms(cfg *config.Config, apiKey, word string) (string, error) {
	if apiKey == "" {
		return "", errors.New("Gemini API key is missing")
	}
	if word == "" {
		return "", errors.New("word cannot be empty")
	}

	// Use the prompt generation logic from the UserScript
	prompt := fmt.Sprintf(`Provide all possible forms (including verb conjugations, plural forms, etc.) of the English word "%s", separated by the pipe symbol '|'. Do not include any additional text or explanations.
 For example, if the word is "run", the output should be "run|runs|ran|running".
 For the input word "%s", the output should be:`, word, word)

	apiURL := fmt.Sprintf("%s?key=%s", cfg.Gemini.APIEndpoint, apiKey)

	requestBody := map[string]interface{}{
		"contents": []map[string]interface{}{
			{
				"parts": []map[string]string{
					{"text": prompt},
				},
			},
		},
		// Add safety settings or generation config if needed
		"generationConfig": map[string]interface{}{
			"temperature":     0.3, // Adjust as needed
			"maxOutputTokens": 100,
		},
		"safetySettings": []map[string]string{
			{"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
			{"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
			{"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
			{"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"},
		},
	}

	jsonData, err := json.Marshal(requestBody)
	if err != nil {
		return "", fmt.Errorf("failed to marshal Gemini request body: %w", err)
	}

	req, err := http.NewRequest("POST", apiURL, bytes.NewBuffer(jsonData))
	if err != nil {
		return "", fmt.Errorf("failed to create Gemini request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to call Gemini API: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("failed to read Gemini response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		log.Printf("Gemini API Error: Status %d, Body: %s", resp.StatusCode, string(bodyBytes))
		// Try to parse error message from Gemini response if possible
		var errorResp map[string]interface{}
		if json.Unmarshal(bodyBytes, &errorResp) == nil {
			if errData, ok := errorResp["error"].(map[string]interface{}); ok {
				if msg, ok := errData["message"].(string); ok {
					return "", fmt.Errorf("Gemini API error (%d): %s", resp.StatusCode, msg)
				}
			}
		}
		return "", fmt.Errorf("Gemini API request failed with status code %d", resp.StatusCode)
	}

	// Parse the response
	var result struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
			FinishReason string `json:"finishReason"`
			// SafetyRatings can be checked here if needed
		} `json:"candidates"`
		// PromptFeedback might contain block reasons
		PromptFeedback *struct {
			BlockReason string `json:"blockReason"`
		} `json:"promptFeedback"`
	}

	if err := json.Unmarshal(bodyBytes, &result); err != nil {
		log.Printf("Failed to unmarshal Gemini response: %s", string(bodyBytes))
		return "", fmt.Errorf("failed to parse Gemini response: %w", err)
	}

	if result.PromptFeedback != nil && result.PromptFeedback.BlockReason != "" {
		return "", fmt.Errorf("Gemini request blocked due to safety settings: %s", result.PromptFeedback.BlockReason)
	}

	if len(result.Candidates) > 0 && len(result.Candidates[0].Content.Parts) > 0 {
		forms := strings.TrimSpace(result.Candidates[0].Content.Parts[0].Text)
		// Basic validation: ensure the original word is present
		if forms == "" || !strings.Contains(forms, word) {
			log.Printf("Warning: Gemini output for '%s' seems invalid or empty: '%s'. Falling back to just the word.", word, forms)
			// Fallback to just the original word if Gemini fails or gives weird output
			return word, nil // Return at least the base word
		}
		return forms, nil
	}

	log.Printf("Gemini response for '%s' did not contain expected content structure. Body: %s", word, string(bodyBytes))
	// Fallback if structure is wrong
	return word, nil // Return base word as fallback
}

// HandleDeleteEntry removes a word entry and its relations
func (h *APIHandlers) HandleDeleteEntry(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserIDContextKey).(int64)
	// Get entry UUID from URL path parameter (requires a router like gorilla/mux or chi, or simple string splitting)
	// Assuming path like /api/entries/{uuid}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/entries/"), "/")
	if len(parts) != 1 || parts[0] == "" {
		writeJSONError(w, http.StatusBadRequest, "Missing or invalid entry UUID in URL path")
		return
	}
	entryUUID := parts[0]

	err := h.DB.DeleteEntryAndRelations(userID, entryUUID)
	if err != nil {
		log.Printf("API DeleteEntry: Failed for user %d, entry %s: %v", userID, entryUUID, err)
		// Distinguish between "not found" and other errors? For now, generic error.
		writeJSONError(w, http.StatusInternalServerError, "Failed to delete entry: "+err.Error())
		return
	}

	log.Printf("API DeleteEntry: Successfully deleted entry %s for user %d", entryUUID, userID)
	writeJSON(w, http.StatusOK, map[string]string{"message": "Entry deleted successfully"})
}

// HandleGetTrainingData provides data for the training page frontend
func (h *APIHandlers) HandleGetTrainingData(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserIDContextKey).(int64)
	// Get limit from query param, e.g., /api/training/data?limit=50
	limitStr := r.URL.Query().Get("limit")
	limit := 50 // Default limit
	if parsedLimit, err := strconv.Atoi(limitStr); err == nil && parsedLimit > 0 && parsedLimit < 500 {
		limit = parsedLimit
	}

	items, err := h.DB.GetTrainingData(userID, limit)
	if err != nil {
		log.Printf("API GetTrainingData: Failed for user %d: %v", userID, err)
		writeJSONError(w, http.StatusInternalServerError, "Failed to retrieve training data")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

// HandleImportData allows importing data from the old format (Temporary)
func (h *APIHandlers) HandleImportData(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserIDContextKey).(int64)

	var data map[string]map[string][]string // Expecting {"dictionary_name": {"urls": [...], "paragraphs": [...], ...}}
	if err := json.NewDecoder(r.Body).Decode(&data); err != nil {
		writeJSONError(w, http.StatusBadRequest, "Invalid JSON data format: "+err.Error())
		return
	}
	defer r.Body.Close()

	entries, urls, paras, rels, err := h.DB.ImportData(userID, data)
	if err != nil {
		log.Printf("API ImportData: Failed for user %d: %v", userID, err)
		writeJSONError(w, http.StatusInternalServerError, "Failed during data import: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"message":            "Import successful",
		"importedEntries":    entries,
		"importedUrls":       urls,
		"importedParagraphs": paras,
		"importedRelations":  rels,
	})
}
