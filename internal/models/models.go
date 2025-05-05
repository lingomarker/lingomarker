package models

import "time"

type User struct {
	ID           int64  `json:"-"` // Keep internal ID private
	Name         string `json:"name"`
	Username     string `json:"username"`
	PasswordHash string `json:"-"` // Never expose hash
}

type UserSettings struct {
	UserID               int64  `json:"-"`
	GeminiAPIKey         string `json:"-"`                    // Keep sensitive info out of JSON where possible
	DictBaseURL          string `json:"dictBaseUrl"`          // Expose non-sensitive settings
	AllowFragmentURLList string `json:"allowFragmentUrlList"` // Keep as string for easier JSON/DB handling
	WordsNumberLimit     int    `json:"wordsNumberLimit"`
	WordsLengthLimit     int    `json:"wordsLengthLimit"`
	HighlightColor       string `json:"highlightColor"`
}

// Data structures based on UserScript needs, adapted for SQL
type Entry struct {
	UUID               string    `json:"uuid"` // Use the UUID from UserScript as primary key? Or generate new? Let's use UserScript UUID.
	UserID             int64     `json:"-"`
	Word               string    `json:"word"`               // The base word form
	FormsPipeSeparated string    `json:"formsPipeSeparated"` // Store forms as they are for now
	CreatedAt          time.Time `json:"createdAt"`
	UpdatedAt          time.Time `json:"updatedAt"`
}

type URL struct {
	ID        int64     `json:"-"` // Internal ID
	UserID    int64     `json:"-"`
	URLHash   string    `json:"urlHash"` // SHA256 hash from UserScript
	URL       string    `json:"url"`
	Title     *string   `json:"title,omitempty"` // Nullable title
	CreatedAt time.Time `json:"createdAt"`
}

type Paragraph struct {
	ID            int64     `json:"-"` // Internal ID
	UserID        int64     `json:"-"`
	ParagraphHash string    `json:"paragraphHash"` // SHA256 hash from UserScript
	Text          string    `json:"text"`
	CreatedAt     time.Time `json:"createdAt"`
}

// Relation connects Entry, URL, and Paragraph for a specific user interaction
type Relation struct {
	ID            int64     `json:"-"` // Internal ID
	UserID        int64     `json:"-"`
	EntryUUID     string    `json:"entryUUID"`
	URLHash       string    `json:"urlHash"`
	ParagraphHash string    `json:"paragraphHash"`
	CreatedAt     time.Time `json:"createdAt"` // When first created
	UpdatedAt     time.Time `json:"updatedAt"` // Timestamp of the last interaction (re-click)
}

// Structure for returning all data needed by UserScript
type UserDataBundle struct {
	Entries    []Entry     `json:"entries"`
	URLs       []URL       `json:"urls"`       // Only those referenced by relations? Or all? Let's send all associated with user.
	Paragraphs []Paragraph `json:"paragraphs"` // Only those referenced by relations? Or all? Let's send all associated with user.
	Relations  []Relation  `json:"relations"`
}

// Structure for the Training Page data
type TrainingItem struct {
	URL       string    `json:"url"`
	Title     *string   `json:"title,omitempty"`
	Paragraph string    `json:"paragraph"`
	Word      string    `json:"word"` // Base word from Entry
	UpdatedAt time.Time `json:"updatedAt"`
}

// PodcastStatus defines the possible states of a podcast transcription job.
type PodcastStatus string

const (
	StatusUploaded     PodcastStatus = "uploaded"
	StatusTranscribing PodcastStatus = "transcribing"
	StatusCompleted    PodcastStatus = "completed"
	StatusFailed       PodcastStatus = "failed"
)

type Podcast struct {
	ID                 string        `json:"id"` // UUID
	UserID             int64         `json:"-"`  // Belongs to user
	Filename           string        `json:"filename"`
	StorePath          string        `json:"-"` // Internal storage path
	Producer           string        `json:"producer"`
	Series             string        `json:"series"`
	Episode            string        `json:"episode"`
	Description        *string       `json:"description,omitempty"` // Nullable
	OriginalTranscript *string       `json:"-"`                     // Keep potentially large text out of list views initially
	FinalTranscript    *string       `json:"-"`                     // Keep potentially large JSON out of list views initially
	UploadTime         time.Time     `json:"uploadTime"`
	Status             PodcastStatus `json:"status"`
	ErrorMessage       *string       `json:"errorMessage,omitempty"` // Nullable error message
}

// Add struct for list view if needed later (omitting large fields)
type PodcastListItem struct {
	ID         string        `json:"id"`
	Producer   string        `json:"producer"`
	Series     string        `json:"series"`
	Episode    string        `json:"episode"`
	UploadTime time.Time     `json:"uploadTime"`
	Status     PodcastStatus `json:"status"`
}
