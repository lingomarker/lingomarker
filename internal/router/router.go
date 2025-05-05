package router

import (
	"context"
	"net/http"
	"strings"
)

// Constants for context keys if we extract path parameters
type contextKey string

const PathParamContextKey = contextKey("pathParams")

// SimpleRouter holds routes
type SimpleRouter struct {
	routes []route
	// Can add fields for middleware, etc. later if needed
}

// route stores information for a single route
type route struct {
	method   string // e.g., "GET", "POST"
	path     string // e.g., "/api/users", "/api/podcasts/" (note trailing slash for prefix)
	isPrefix bool   // Does this path represent a prefix?
	handler  http.Handler
}

// New creates a new SimpleRouter
func New() *SimpleRouter {
	return &SimpleRouter{}
}

// Handle adds a route for a specific method and exact path match
func (r *SimpleRouter) Handle(method, path string, handler http.Handler) {
	r.routes = append(r.routes, route{
		method:   method,
		path:     path,
		isPrefix: false,
		handler:  handler,
	})
}

// HandlePrefix adds a route for a specific method and path prefix match
// Note: More specific paths should generally be registered *before* broader prefixes
func (r *SimpleRouter) HandlePrefix(method, path string, handler http.Handler) {
	if !strings.HasSuffix(path, "/") {
		path += "/" // Ensure prefix paths end with a slash for clarity
	}
	r.routes = append(r.routes, route{
		method:   method,
		path:     path,
		isPrefix: true,
		handler:  handler,
	})
}

// ServeHTTP makes SimpleRouter implement http.Handler
func (r *SimpleRouter) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	requestPath := req.URL.Path

	for _, rt := range r.routes {
		// 1. Check Method
		if rt.method != "" && rt.method != req.Method {
			continue // Method doesn't match
		}

		// 2. Check Path
		if rt.isPrefix {
			// Prefix Match
			if strings.HasPrefix(requestPath, rt.path) {
				// Simple Parameter Extraction (Example: /prefix/value -> value)
				// More robust param extraction would need better pattern matching.
				paramValue := strings.TrimPrefix(requestPath, rt.path)
				if paramValue != "" && strings.Contains(paramValue, "/") {
					// Don't match if there are more slashes after the prefix/param
					// e.g., /prefix/value/extra shouldn't match /prefix/
					// This is a basic way to handle it; real routers are smarter.
					// If we need /prefix/value/subpath, register /prefix/ explicitly.
				} else if paramValue != "" {
					// Store the extracted part in the context
					// Note: Only captures ONE value after the prefix.
					ctx := context.WithValue(req.Context(), PathParamContextKey, paramValue)
					rt.handler.ServeHTTP(w, req.WithContext(ctx))
					return // Route handled
				} else if requestPath == rt.path { // Exact match for prefix path itself
					rt.handler.ServeHTTP(w, req)
					return // Route handled
				}
				// If paramValue is empty but path has prefix, it might be an exact match handled below
				// or a mismatch if e.g. reqPath is /prefix/ but route path is /prefix/ (no trailing slash)
				// Let's assume exact match handles this case. Continue searching.

			}
		} else {
			// Exact Match
			if rt.path == requestPath {
				rt.handler.ServeHTTP(w, req)
				return // Route handled
			}
		}
	}

	// No matching route found
	http.NotFound(w, req)
}

// GetPathParam retrieves a path parameter stored in the context by ServeHTTP.
// Returns an empty string if not found. (Assumes only one parameter).
func GetPathParam(ctx context.Context) string {
	value, ok := ctx.Value(PathParamContextKey).(string)
	if !ok {
		return ""
	}
	return value
}
