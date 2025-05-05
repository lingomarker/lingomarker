package transcription

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"google.golang.org/genai"
)

// Config holds transcription related configuration (could be extended)
type Config struct {
	ModelName string // e.g., "gemini-2.0-flash"
}

// Service handles transcription tasks
type Service struct {
	cfg *Config
}

// NewService creates a transcription service
func NewService(cfg *Config) *Service {
	if cfg.ModelName == "" {
		cfg.ModelName = "gemini-2.0-flash" // Use a sensible default, maybe flash? Check latest recommended model
		log.Printf("Transcription model name not configured, defaulting to %s", cfg.ModelName)
	}
	return &Service{cfg: cfg}
}

// TranscribeAudioFile calls the Gemini API to transcribe audio.
// Takes the full path to the audio file, description, optional original transcript, and API key.
// Returns the generated transcript as a JSON string.
func (s *Service) TranscribeAudioFile(ctx context.Context, audioFilePath, description, originalTranscript, apiKey string) (string, error) {
	if apiKey == "" {
		return "", fmt.Errorf("transcription requires a valid Gemini API key")
	}

	client, err := genai.NewClient(ctx, &genai.ClientConfig{
		APIKey:  apiKey,
		Backend: genai.BackendGeminiAPI,
	})
	if err != nil {
		return "", fmt.Errorf("failed to create genai client: %w", err)
	}

	localAudioPath := audioFilePath
	uploadedFile, err := client.Files.UploadFromPath(
		ctx,
		localAudioPath,
		nil,
	)
	if err != nil {
		return "", fmt.Errorf("failed to upload audio file to Gemini API: %w", err)
	}

	parts := []*genai.Part{
		genai.NewPartFromText(fmt.Sprintf(`Transcribe the following audio from a podcast episode.
		Generate the transcript in JSON format with speaker diarization and timestamps.
		Use the following podcast description for context: `+"```"+`%s`+"```"+`.
		Use the following original transcript as a reference: `+"```"+`%s`+"```"+`.
		The audio may contain advertisements that are typically not included in the original transcript.
		Merge the ad sections (from the generated transcript) back into the original transcript, ensuring correct timestamps.
		Format the final output as a JSON array of objects, where each object contains speaker, timestamp, and text.`, description, originalTranscript)),
		genai.NewPartFromURI(uploadedFile.URI, uploadedFile.MIMEType),
	}
	contents := []*genai.Content{
		genai.NewContentFromParts(parts, genai.RoleUser),
	}

	result, err := client.Models.GenerateContent(
		ctx,
		s.cfg.ModelName,
		contents,
		nil,
	)
	if err != nil {
		return "", fmt.Errorf("failed to generate content with Gemini API: %w", err)
	}

	var geminiText string
	if result != nil && len(result.Text()) > 0 {
		geminiText = result.Text()
	} else {
		return "", fmt.Errorf("gemini API returned empty response")
	}

	// Simple attempt to extract potential JSON block (might need more robust parsing)
	// Look for the start and end of the JSON array
	jsonStart := findJSONStart(geminiText)
	jsonEnd := findJSONEnd(geminiText)

	if jsonStart == -1 || jsonEnd == -1 || jsonEnd < jsonStart {
		log.Printf("Warning: Could not find valid JSON block in Gemini response: %s", geminiText)
		// As a fallback, return the raw text response wrapped in a simple JSON structure
		fallbackJSON, _ := json.Marshal(map[string]string{"raw_text": geminiText})
		return string(fallbackJSON), fmt.Errorf("could not extract JSON from gemini response, returning raw text fallback")
	}

	extractedJSON := geminiText[jsonStart : jsonEnd+1]

	// Validate the JSON structure more formally
	var tempJson []map[string]interface{}
	if err := json.Unmarshal([]byte(extractedJSON), &tempJson); err != nil {
		log.Printf("Error: Gemini response failed JSON validation: %v\nResponse Text: %s", err, extractedJSON)
		return "", fmt.Errorf("gemini response failed JSON validation: %w", err)
	}

	log.Printf("Transcription successful for: %s", audioFilePath)
	return extractedJSON, nil // Return the validated JSON string
}

// findJSONStart attempts to find the index of the start of a JSON array.
func findJSONStart(text string) int {
	// Find the first occurrence of '[' not preceded by text that looks like markdown code block start
	// This is a simplified heuristic. A real parser would be better.
	idx := 0
	for idx < len(text) {
		if text[idx] == '[' {
			// Simple check to avoid markdown code blocks like ```json
			if idx >= 3 && text[idx-3:idx] == "```" {
				idx++ // Skip past this potential false positive
				continue
			}
			return idx
		}
		idx++
	}
	return -1
}

// findJSONEnd attempts to find the index of the end of a JSON array.
func findJSONEnd(text string) int {
	// Find the last occurrence of ']'
	idx := len(text) - 1
	for idx >= 0 {
		if text[idx] == ']' {
			// Simple check to avoid markdown code blocks like ```
			if idx+3 <= len(text) && text[idx+1:idx+4] == "```" {
				idx-- // Skip backwards
				continue
			}
			return idx
		}
		idx--
	}
	return -1
}
