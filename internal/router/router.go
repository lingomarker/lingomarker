// internal/router/router.go
package router

import (
	"context"
	"net/http"
	"strings"
)

// Context key type
type contextKey string

const PathParamContextKey = contextKey("pathParams") // Can store string or map[string]string

// SimpleRouter holds routes
type SimpleRouter struct {
	routes []route
}

// route stores information for a single route
type route struct {
	method   string
	path     string
	isPrefix bool
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
func (r *SimpleRouter) HandlePrefix(method, path string, handler http.Handler) {
	if !strings.HasSuffix(path, "/") {
		path += "/"
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
			continue
		}

		// 2. Check Path
		if rt.isPrefix {
			// Prefix Match
			if strings.HasPrefix(requestPath, rt.path) {
				// Extract the full suffix *after* the registered prefix path
				// Example: rt.path = "/api/podcasts/", requestPath = "/api/podcasts/123/play_data"
				// suffix = "123/play_data"
				suffix := strings.TrimPrefix(requestPath, rt.path)

				// *** MODIFIED LOGIC START ***
				// We *always* match if the prefix matches. The registered handler
				// is responsible for parsing the suffix and deciding if it's valid.
				// We store the *entire suffix* in the context for the handler to use.
				// The handler can then split it by "/" or use regex if needed.

				ctx := context.WithValue(req.Context(), PathParamContextKey, suffix)
				rt.handler.ServeHTTP(w, req.WithContext(ctx))
				return // Route handled

				// *** MODIFIED LOGIC END ***

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

// GetPathParam retrieves the *entire suffix* stored in the context by ServeHTTP for prefix routes.
// The handler is now responsible for parsing this suffix.
func GetPathParam(ctx context.Context) string {
	value, ok := ctx.Value(PathParamContextKey).(string)
	if !ok {
		return ""
	}
	return value
}
