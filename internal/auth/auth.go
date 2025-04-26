package auth

import (
	"errors"
	"lingomarker/internal/config"
	"lingomarker/internal/database"
	"net/http"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

// HashPassword generates a bcrypt hash of the password
func HashPassword(password string) (string, error) {
	bytes, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	return string(bytes), err
}

// CheckPasswordHash compares a plain text password with a hash
func CheckPasswordHash(password, hash string) bool {
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
	return err == nil
}

// CreateSession creates a new session for the user and returns the session ID
func CreateSession(db *database.DB, userID int64, maxAge time.Duration) (string, time.Time, error) {
	sessionID := uuid.NewString()
	expiry := time.Now().Add(maxAge)
	err := db.CreateSession(sessionID, userID, expiry)
	if err != nil {
		return "", time.Time{}, err
	}
	return sessionID, expiry, nil
}

// ValidateSession checks if a session ID is valid and returns the user ID
func ValidateSession(db *database.DB, sessionID string) (int64, error) {
	if sessionID == "" {
		return 0, errors.New("no session ID provided")
	}
	return db.GetUserIDFromSession(sessionID)
}

// SetSessionCookie sets the session cookie in the HTTP response
func SetSessionCookie(w http.ResponseWriter, cfg *config.Config, sessionID string, expiry time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     cfg.Session.CookieName,
		Value:    sessionID,
		Expires:  expiry,
		Path:     "/",                  // Accessible site-wide
		HttpOnly: true,                 // Prevent JavaScript access
		Secure:   true,                 // Only send over HTTPS
		SameSite: http.SameSiteLaxMode, // Good default for CSRF protection
	})
}

// ClearSessionCookie removes the session cookie
func ClearSessionCookie(w http.ResponseWriter, cfg *config.Config) {
	http.SetCookie(w, &http.Cookie{
		Name:     cfg.Session.CookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1, // Deletes the cookie
	})
}

// GetUserIDFromRequest retrieves the user ID from the session cookie in the request
func GetUserIDFromRequest(r *http.Request, db *database.DB, cfg *config.Config) (int64, error) {
	cookie, err := r.Cookie(cfg.Session.CookieName)
	if err != nil {
		if errors.Is(err, http.ErrNoCookie) {
			return 0, errors.New("user not authenticated: no session cookie")
		}
		return 0, errors.New("error reading session cookie")
	}
	return ValidateSession(db, cookie.Value)
}
