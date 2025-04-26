package config

import (
	"os"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Server struct {
		Domain      string        `yaml:"domain"`
		Address     string        `yaml:"address"`
		Timeout     time.Duration `yaml:"timeout"`
		CertDir     string        `yaml:"cert_dir"`
		TLSCertFile string        `yaml:"tls_cert_file"`
		TLSKeyFile  string        `yaml:"tls_key_file"`
	} `yaml:"server"`
	Database struct {
		DSN string `yaml:"dsn"` // Data Source Name (e.g., path for SQLite)
	} `yaml:"database"`
	Session struct {
		CookieName string        `yaml:"cookie_name"`
		SecretKey  string        `yaml:"secret_key"` // Use a strong random key in production!
		MaxAge     time.Duration `yaml:"max_age"`
	} `yaml:"session"`
	Gemini struct {
		APIEndpoint string `yaml:"api_endpoint"`
	} `yaml:"gemini"`
	Web struct {
		TemplateDir string `yaml:"template_dir"`
		StaticDir   string `yaml:"static_dir"`
	} `yaml:"web"`
}

func LoadConfig(path string) (*Config, error) {
	cfg := &Config{
		// Default values
		Server: struct {
			Domain      string        `yaml:"domain"`
			Address     string        `yaml:"address"`
			Timeout     time.Duration `yaml:"timeout"`
			CertDir     string        `yaml:"cert_dir"`
			TLSCertFile string        `yaml:"tls_cert_file"`
			TLSKeyFile  string        `yaml:"tls_key_file"`
		}{
			Domain:      "dev.lingomarker.com",
			Address:     ":443", // Default HTTPS port
			Timeout:     30 * time.Second,
			CertDir:     "./certs",
			TLSCertFile: "./certs/server.crt",
			TLSKeyFile:  "./certs/server.key",
		},
		Database: struct {
			DSN string `yaml:"dsn"`
		}{
			DSN: "./lingomarker.db",
		},
		Session: struct {
			CookieName string        `yaml:"cookie_name"`
			SecretKey  string        `yaml:"secret_key"`
			MaxAge     time.Duration `yaml:"max_age"`
		}{
			CookieName: "lingomarker_session",
			SecretKey:  "very-insecure-secret-key-change-me", // CHANGE THIS!
			MaxAge:     7 * 24 * time.Hour,                   // 7 days
		},
		Gemini: struct {
			APIEndpoint string `yaml:"api_endpoint"`
		}{
			APIEndpoint: "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent", // Or your preferred model
		},
		Web: struct {
			TemplateDir string `yaml:"template_dir"`
			StaticDir   string `yaml:"static_dir"`
		}{
			TemplateDir: "./web/templates",
			StaticDir:   "./web/static",
		},
	}

	f, err := os.Open(path)
	if err != nil {
		// If config file doesn't exist, return defaults (or handle error)
		if os.IsNotExist(err) {
			return cfg, nil // Use defaults if no config file
		}
		return nil, err
	}
	defer f.Close()

	decoder := yaml.NewDecoder(f)
	if err := decoder.Decode(cfg); err != nil {
		return nil, err
	}

	return cfg, nil
}
