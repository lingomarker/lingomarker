package tlsgen

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// EnsureCerts generates a CA and server certificate if they don't exist.
func EnsureCerts(certDir, caCertPath, caKeyPath, serverCertPath, serverKeyPath, domain string) error {
	// Create certs directory if it doesn't exist
	if err := os.MkdirAll(certDir, 0755); err != nil {
		return fmt.Errorf("failed to create cert directory %s: %w", certDir, err)
	}

	// Check if CA files exist
	if _, err := os.Stat(caCertPath); os.IsNotExist(err) {
		fmt.Println("CA certificate not found, generating new CA...")
		if err := generateCA(caCertPath, caKeyPath, domain); err != nil {
			return fmt.Errorf("failed to generate CA: %w", err)
		}
		fmt.Println("CA generated successfully.")
	} else if err != nil {
		return fmt.Errorf("failed to stat CA certificate %s: %w", caCertPath, err)
	}

	// Check if server files exist
	if _, err := os.Stat(serverCertPath); os.IsNotExist(err) {
		fmt.Println("Server certificate not found, generating new server cert...")
		if err := generateServerCert(caCertPath, caKeyPath, serverCertPath, serverKeyPath, domain); err != nil {
			return fmt.Errorf("failed to generate server certificate: %w", err)
		}
		fmt.Println("Server certificate generated successfully.")
	} else if err != nil {
		return fmt.Errorf("failed to stat server certificate %s: %w", serverCertPath, err)
	}

	fmt.Printf("TLS certificates ensured in %s\n", certDir)
	return nil
}

func generateCA(certPath, keyPath, domain string) error {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("failed to generate private key: %w", err)
	}

	serialNumberLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serialNumber, err := rand.Int(rand.Reader, serialNumberLimit)
	if err != nil {
		return fmt.Errorf("failed to generate serial number: %w", err)
	}

	template := x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			Organization: []string{"LingoMarker Dev CA"},
			CommonName:   fmt.Sprintf("LingoMarker Dev CA for %s", domain),
		},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().AddDate(10, 0, 0), // 10 years validity
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
	}

	derBytes, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	if err != nil {
		return fmt.Errorf("failed to create certificate: %w", err)
	}

	// Save certificate
	certOut, err := os.Create(certPath)
	if err != nil {
		return fmt.Errorf("failed to open cert.pem for writing: %w", err)
	}
	if err := pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: derBytes}); err != nil {
		return fmt.Errorf("failed to write data to cert.pem: %w", err)
	}
	if err := certOut.Close(); err != nil {
		return fmt.Errorf("error closing cert.pem: %w", err)
	}
	fmt.Printf("Wrote %s\n", certPath)

	// Save private key
	keyOut, err := os.OpenFile(keyPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return fmt.Errorf("failed to open key.pem for writing: %w", err)
	}
	privBytes, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return fmt.Errorf("unable to marshal private key: %w", err)
	}
	if err := pem.Encode(keyOut, &pem.Block{Type: "PRIVATE KEY", Bytes: privBytes}); err != nil {
		return fmt.Errorf("failed to write data to key.pem: %w", err)
	}
	if err := keyOut.Close(); err != nil {
		return fmt.Errorf("error closing key.pem: %w", err)
	}
	fmt.Printf("Wrote %s\n", keyPath)
	return nil
}

func generateServerCert(caCertPath, caKeyPath, certPath, keyPath, domain string) error {
	// Load CA
	caCertPEM, err := os.ReadFile(caCertPath)
	if err != nil {
		return fmt.Errorf("failed to read CA cert: %w", err)
	}
	caKeyPEM, err := os.ReadFile(caKeyPath)
	if err != nil {
		return fmt.Errorf("failed to read CA key: %w", err)
	}

	caCertBlock, _ := pem.Decode(caCertPEM)
	if caCertBlock == nil || caCertBlock.Type != "CERTIFICATE" {
		return fmt.Errorf("failed to decode CA certificate PEM")
	}
	caCert, err := x509.ParseCertificate(caCertBlock.Bytes)
	if err != nil {
		return fmt.Errorf("failed to parse CA certificate: %w", err)
	}

	caKeyBlock, _ := pem.Decode(caKeyPEM)
	if caKeyBlock == nil || caKeyBlock.Type != "PRIVATE KEY" {
		// Try other potential types if needed, e.g., "EC PRIVATE KEY"
		return fmt.Errorf("failed to decode CA private key PEM (ensure PKCS8 format)")
	}
	caPrivKey, err := x509.ParsePKCS8PrivateKey(caKeyBlock.Bytes)
	if err != nil {
		return fmt.Errorf("failed to parse CA private key: %w", err)
	}

	// Prepare server certificate template
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("failed to generate server private key: %w", err)
	}

	serialNumberLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serialNumber, err := rand.Int(rand.Reader, serialNumberLimit)
	if err != nil {
		return fmt.Errorf("failed to generate serial number: %w", err)
	}

	template := x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			Organization: []string{"LingoMarker Dev Server"},
			CommonName:   domain, // Common Name should be the primary domain
		},
		NotBefore:   time.Now(),
		NotAfter:    time.Now().AddDate(1, 0, 0), // 1 year validity
		KeyUsage:    x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:    []string{domain, strings.Replace(domain, "dev.", "*.", 1)}, // e.g., dev.lingomarker.com, *.lingomarker.com
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},     // Include localhost IPs
	}

	// Sign the server certificate with the CA
	derBytes, err := x509.CreateCertificate(rand.Reader, &template, caCert, &priv.PublicKey, caPrivKey)
	if err != nil {
		return fmt.Errorf("failed to create server certificate: %w", err)
	}

	// Save server certificate
	certOut, err := os.Create(certPath)
	if err != nil {
		return fmt.Errorf("failed to open server cert.pem for writing: %w", err)
	}
	if err := pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: derBytes}); err != nil {
		_ = certOut.Close()
		return fmt.Errorf("failed to write data to server cert.pem: %w", err)
	}
	if err := certOut.Close(); err != nil {
		return fmt.Errorf("error closing server cert.pem: %w", err)
	}
	fmt.Printf("Wrote %s\n", certPath)

	// Save server private key
	keyOut, err := os.OpenFile(keyPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return fmt.Errorf("failed to open server key.pem for writing: %w", err)
	}
	privBytes, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		_ = keyOut.Close()
		return fmt.Errorf("unable to marshal server private key: %w", err)
	}
	if err := pem.Encode(keyOut, &pem.Block{Type: "PRIVATE KEY", Bytes: privBytes}); err != nil {
		_ = keyOut.Close()
		return fmt.Errorf("failed to write data to server key.pem: %w", err)
	}
	if err := keyOut.Close(); err != nil {
		return fmt.Errorf("error closing server key.pem: %w", err)
	}
	fmt.Printf("Wrote %s\n", keyPath)

	return nil
}

// Helper: Get the absolute path for the CA certificate for user instructions
func GetCACertPath(certDir, caCertFile string) (string, error) {
	absCertDir, err := filepath.Abs(certDir)
	if err != nil {
		return "", err
	}
	return filepath.Join(absCertDir, filepath.Base(caCertFile)), nil
}
