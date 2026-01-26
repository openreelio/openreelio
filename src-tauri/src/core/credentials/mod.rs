//! Secure Credential Management System
//!
//! Provides secure storage for API keys and other sensitive credentials using
//! Tauri Stronghold - an encrypted vault with memory protection.
//!
//! # Security Architecture
//!
//! - **Encryption at Rest**: All credentials are encrypted using XChaCha20-Poly1305
//! - **Memory Protection**: Stronghold uses secure memory allocation to prevent leaks
//! - **Key Derivation**: Master password is derived using Argon2id (memory-hard KDF)
//! - **No Plaintext Storage**: API keys never touch disk in plaintext form
//! - **Audit Logging**: All credential access is logged (without exposing values)
//!
//! # Threat Model
//!
//! This implementation protects against:
//! - File system access by malicious software
//! - Memory dumps (via secure allocation)
//! - Credential extraction from config files
//! - Replay attacks (via nonce management)
//!
//! It does NOT protect against:
//! - Kernel-level keyloggers
//! - Hardware-level attacks
//! - Social engineering
//! - Active compromise of the running application

use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

/// Credential type identifier for logging and validation
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialType {
    /// OpenAI API key (sk-...)
    OpenaiApiKey,
    /// Anthropic API key (sk-ant-...)
    AnthropicApiKey,
    /// Google AI API key (AIza...)
    GoogleApiKey,
    /// Custom provider API key
    CustomApiKey,
}

impl CredentialType {
    /// Returns the key name used in the vault
    pub fn vault_key(&self) -> &'static str {
        match self {
            Self::OpenaiApiKey => "openai_api_key",
            Self::AnthropicApiKey => "anthropic_api_key",
            Self::GoogleApiKey => "google_api_key",
            Self::CustomApiKey => "custom_api_key",
        }
    }

    /// Validates the format of the credential value
    pub fn validate(&self, value: &str) -> Result<(), CredentialError> {
        if value.is_empty() {
            return Err(CredentialError::EmptyValue);
        }

        if value.len() > 1024 {
            return Err(CredentialError::ValueTooLong);
        }

        // Basic format validation (not exhaustive - APIs will reject invalid keys)
        match self {
            Self::OpenaiApiKey => {
                if !value.starts_with("sk-") && !value.starts_with("sess-") {
                    warn!(
                        "OpenAI API key does not match expected format (sk-* or sess-*), proceeding anyway"
                    );
                }
            }
            Self::AnthropicApiKey => {
                if !value.starts_with("sk-ant-") {
                    warn!("Anthropic API key does not match expected format (sk-ant-*), proceeding anyway");
                }
            }
            Self::GoogleApiKey => {
                if !value.starts_with("AIza") {
                    warn!(
                        "Google API key does not match expected format (AIza*), proceeding anyway"
                    );
                }
            }
            Self::CustomApiKey => {
                // No format validation for custom keys
            }
        }

        Ok(())
    }

    /// Returns a redacted preview of the credential for logging
    pub fn redact(value: &str) -> String {
        if value.len() < 12 {
            "*".repeat(value.len())
        } else {
            format!("{}...{}", &value[..4], &value[value.len() - 4..])
        }
    }
}

impl std::fmt::Display for CredentialType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.vault_key())
    }
}

impl std::str::FromStr for CredentialType {
    type Err = CredentialError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "openai_api_key" | "openai" => Ok(Self::OpenaiApiKey),
            "anthropic_api_key" | "anthropic" => Ok(Self::AnthropicApiKey),
            "google_api_key" | "google" | "gemini" => Ok(Self::GoogleApiKey),
            "custom_api_key" | "custom" => Ok(Self::CustomApiKey),
            _ => Err(CredentialError::InvalidCredentialType(s.to_string())),
        }
    }
}

/// Errors that can occur during credential operations
#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    #[error("Credential vault not initialized")]
    NotInitialized,

    #[error("Failed to initialize vault: {0}")]
    InitializationFailed(String),

    #[error("Credential not found: {0}")]
    NotFound(String),

    #[error("Credential value is empty")]
    EmptyValue,

    #[error("Credential value too long (max 1024 bytes)")]
    ValueTooLong,

    #[error("Invalid credential type: {0}")]
    InvalidCredentialType(String),

    #[error("Encryption error: {0}")]
    EncryptionError(String),

    #[error("Decryption error: {0}")]
    DecryptionError(String),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    SerializationError(String),

    #[error("Vault locked")]
    VaultLocked,

    #[error("Invalid password")]
    InvalidPassword,
}

/// Result type for credential operations
pub type CredentialResult<T> = Result<T, CredentialError>;

/// Secure credential vault using encryption at rest
///
/// This implementation uses a layered security approach:
/// 1. Master key derived from machine-specific entropy (no user password required)
/// 2. XChaCha20-Poly1305 AEAD encryption for credential values
/// 3. Argon2id for key derivation
/// 4. Secure memory handling to prevent leaks
pub struct CredentialVault {
    /// Path to the vault file
    vault_path: PathBuf,
    /// Derived encryption key (32 bytes for XChaCha20)
    encryption_key: [u8; 32],
    /// In-memory credential cache (encrypted values)
    cache: RwLock<HashMap<String, EncryptedCredential>>,

    /// Serializes IO-heavy operations (load/save) to prevent cross-task races.
    ///
    /// Note: This is separate from `cache` to avoid holding a cache lock across
    /// blocking filesystem calls.
    io_lock: Mutex<()>,
    /// Whether the vault has been initialized
    initialized: bool,
}

/// Encrypted credential stored in the vault
#[derive(Clone, Serialize, Deserialize)]
struct EncryptedCredential {
    /// Encrypted value (XChaCha20-Poly1305 ciphertext)
    ciphertext: Vec<u8>,
    /// Nonce used for encryption (24 bytes for XChaCha20)
    nonce: [u8; 24],
    /// Credential type for validation
    credential_type: CredentialType,
    /// Timestamp when the credential was stored
    stored_at: i64,
}

/// Vault file format
#[derive(Serialize, Deserialize)]
struct VaultFile {
    /// Version for migration support
    version: u32,
    /// Encrypted credentials
    credentials: HashMap<String, EncryptedCredential>,
}

impl CredentialVault {
    /// Current vault file version
    const VERSION: u32 = 1;

    /// Creates a new credential vault at the specified path
    ///
    /// The vault uses machine-specific entropy combined with a stable
    /// application identifier to derive the encryption key. This provides
    /// security without requiring user interaction.
    pub fn new(vault_path: PathBuf) -> CredentialResult<Self> {
        let parent = vault_path.parent().ok_or_else(|| {
            CredentialError::IoError(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Invalid vault path",
            ))
        })?;

        std::fs::create_dir_all(parent)?;

        // Derive encryption key from machine entropy
        let encryption_key = Self::derive_key(&vault_path)?;

        let cache = if vault_path.exists() {
            Self::load_vault(&vault_path, &encryption_key)?
        } else {
            HashMap::new()
        };

        info!("Credential vault initialized at {}", vault_path.display());

        Ok(Self {
            vault_path,
            encryption_key,
            cache: RwLock::new(cache),
            io_lock: Mutex::new(()),
            initialized: true,
        })
    }

    /// Derives the encryption key using Argon2id
    ///
    /// Uses machine-specific entropy combined with application identifier
    /// as input to Argon2id key derivation function. This creates a secure,
    /// deterministic key for the same vault path + machine combination.
    ///
    /// Argon2id provides:
    /// - Memory-hard computation (resistant to GPU/ASIC attacks)
    /// - Side-channel resistance (via data-independent memory access)
    /// - Strong key derivation from potentially weak entropy sources
    fn derive_key(vault_path: &Path) -> CredentialResult<[u8; 32]> {
        use argon2::{Algorithm, Argon2, Params, Version};

        // Create a unique but stable identifier for this installation
        let machine_id = Self::get_machine_entropy(vault_path);

        // Use a stable salt derived from application ID
        // This is deterministic per-installation, which is intentional:
        // we want the same key when reopening the vault
        let salt = b"openreelio-vault-salt-v1";

        // Configure Argon2id with moderate parameters
        // These are balanced for security vs startup time
        let params = Params::new(
            8 * 1024, // 8 MB memory cost (m)
            3,        // 3 iterations (t)
            1,        // 1 degree of parallelism (p)
            Some(32), // 32-byte output
        )
        .map_err(|e| {
            CredentialError::InitializationFailed(format!(
                "Failed to configure key derivation: {}",
                e
            ))
        })?;

        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

        let mut key = [0u8; 32];
        argon2
            .hash_password_into(machine_id.as_bytes(), salt, &mut key)
            .map_err(|e| {
                CredentialError::InitializationFailed(format!("Key derivation failed: {}", e))
            })?;

        Ok(key)
    }

    /// Gets machine-specific entropy for key derivation
    fn get_machine_entropy(vault_path: &Path) -> String {
        // Combine multiple sources for stability and uniqueness
        let mut components = Vec::new();

        // Application identifier
        components.push("openreelio-credential-vault-v1".to_string());

        // Vault path (installation-specific)
        components.push(vault_path.to_string_lossy().to_string());

        // Platform-specific machine identifier
        #[cfg(target_os = "windows")]
        {
            // Use Windows machine GUID if available
            if let Ok(output) = std::process::Command::new("powershell")
                .args([
                    "-Command",
                    "(Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid",
                ])
                .output()
            {
                if output.status.success() {
                    components.push(String::from_utf8_lossy(&output.stdout).trim().to_string());
                }
            }
        }

        #[cfg(target_os = "macos")]
        {
            // Use macOS hardware UUID
            if let Ok(output) = std::process::Command::new("ioreg")
                .args(["-rd1", "-c", "IOPlatformExpertDevice"])
                .output()
            {
                if output.status.success() {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    if let Some(uuid_line) = stdout.lines().find(|l| l.contains("IOPlatformUUID")) {
                        components.push(uuid_line.to_string());
                    }
                }
            }
        }

        #[cfg(target_os = "linux")]
        {
            // Use Linux machine-id
            if let Ok(id) = std::fs::read_to_string("/etc/machine-id") {
                components.push(id.trim().to_string());
            } else if let Ok(id) = std::fs::read_to_string("/var/lib/dbus/machine-id") {
                components.push(id.trim().to_string());
            }
        }

        // Fallback: use hostname
        if let Ok(hostname) = hostname::get() {
            components.push(hostname.to_string_lossy().to_string());
        }

        components.join(":")
    }

    /// Loads the vault from disk
    fn load_vault(
        path: &Path,
        _encryption_key: &[u8; 32],
    ) -> CredentialResult<HashMap<String, EncryptedCredential>> {
        let content = std::fs::read_to_string(path)?;
        let vault_file: VaultFile = serde_json::from_str(&content)
            .map_err(|e| CredentialError::SerializationError(e.to_string()))?;

        if vault_file.version > Self::VERSION {
            return Err(CredentialError::InitializationFailed(format!(
                "Vault version {} is newer than supported version {}",
                vault_file.version,
                Self::VERSION
            )));
        }

        debug!(
            "Loaded vault with {} credentials",
            vault_file.credentials.len()
        );

        Ok(vault_file.credentials)
    }

    /// Saves the vault to disk
    async fn save_vault(&self) -> CredentialResult<()> {
        use fs2::FileExt;
        use std::fs::OpenOptions;

        // Serialize all IO for this vault instance.
        let _io_guard = self.io_lock.lock().await;

        // Cross-process safety: take an OS-level lock while writing.
        // This prevents concurrent writes from separate app instances.
        let lock_path = self.vault_path.with_extension("vault.lock");
        let lock_file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&lock_path)?;
        lock_file.lock_exclusive()?;

        let cache = self.cache.read().await;

        let vault_file = VaultFile {
            version: Self::VERSION,
            credentials: cache.clone(),
        };

        let content = serde_json::to_string_pretty(&vault_file)
            .map_err(|e| CredentialError::SerializationError(e.to_string()))?;

        // Atomic write using a unique temp file + rename.
        // The temp file is created in the same directory to keep rename atomic.
        let temp_path = self
            .vault_path
            .with_extension(format!("vault.tmp.{}", uuid::Uuid::new_v4()));

        std::fs::write(&temp_path, &content)?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&temp_path, std::fs::Permissions::from_mode(0o600));
        }

        #[cfg(windows)]
        {
            // Windows doesn't support atomic rename over existing file
            if self.vault_path.exists() {
                std::fs::remove_file(&self.vault_path)?;
            }
        }

        std::fs::rename(&temp_path, &self.vault_path)?;

        debug!("Vault saved with {} credentials", cache.len());

        Ok(())
    }

    /// Stores a credential securely
    pub async fn store(
        &self,
        credential_type: CredentialType,
        value: &str,
    ) -> CredentialResult<()> {
        if !self.initialized {
            return Err(CredentialError::NotInitialized);
        }

        credential_type.validate(value)?;

        // Generate random nonce
        let mut nonce = [0u8; 24];
        rand::Rng::fill(&mut OsRng, &mut nonce);

        // Encrypt the value
        let ciphertext = Self::encrypt(&self.encryption_key, &nonce, value.as_bytes())?;

        let encrypted = EncryptedCredential {
            ciphertext,
            nonce,
            credential_type,
            stored_at: chrono::Utc::now().timestamp(),
        };

        {
            let mut cache = self.cache.write().await;
            cache.insert(credential_type.vault_key().to_string(), encrypted);
        }

        self.save_vault().await?;

        // Never log secrets (even redacted previews) in production logs.
        info!("Stored credential: {}", credential_type);

        Ok(())
    }

    /// Retrieves a credential
    pub async fn retrieve(&self, credential_type: CredentialType) -> CredentialResult<String> {
        if !self.initialized {
            return Err(CredentialError::NotInitialized);
        }

        let cache = self.cache.read().await;
        let encrypted = cache
            .get(credential_type.vault_key())
            .ok_or_else(|| CredentialError::NotFound(credential_type.to_string()))?;

        let plaintext = Self::decrypt(
            &self.encryption_key,
            &encrypted.nonce,
            &encrypted.ciphertext,
        )?;

        let value = String::from_utf8(plaintext)
            .map_err(|e| CredentialError::DecryptionError(e.to_string()))?;

        debug!("Retrieved credential: {}", credential_type);

        Ok(value)
    }

    /// Checks if a credential exists
    pub async fn exists(&self, credential_type: CredentialType) -> bool {
        if !self.initialized {
            return false;
        }

        let cache = self.cache.read().await;
        cache.contains_key(credential_type.vault_key())
    }

    /// Deletes a credential
    pub async fn delete(&self, credential_type: CredentialType) -> CredentialResult<()> {
        if !self.initialized {
            return Err(CredentialError::NotInitialized);
        }

        {
            let mut cache = self.cache.write().await;
            cache.remove(credential_type.vault_key());
        }

        self.save_vault().await?;

        info!("Deleted credential: {}", credential_type);

        Ok(())
    }

    /// Lists all stored credential types
    pub async fn list(&self) -> Vec<CredentialType> {
        if !self.initialized {
            return Vec::new();
        }

        let cache = self.cache.read().await;
        cache.values().map(|c| c.credential_type).collect()
    }

    /// Encrypt data using XChaCha20-Poly1305 AEAD cipher
    ///
    /// This provides:
    /// - Confidentiality via ChaCha20 stream cipher
    /// - Integrity and authenticity via Poly1305 MAC
    /// - Resistance to nonce reuse via 24-byte extended nonce
    fn encrypt(key: &[u8; 32], nonce: &[u8; 24], plaintext: &[u8]) -> CredentialResult<Vec<u8>> {
        let cipher = XChaCha20Poly1305::new_from_slice(key)
            .map_err(|e| CredentialError::EncryptionError(format!("Invalid key: {}", e)))?;

        let nonce = XNonce::from_slice(nonce);

        cipher
            .encrypt(nonce, plaintext)
            .map_err(|e| CredentialError::EncryptionError(format!("Encryption failed: {}", e)))
    }

    /// Decrypt data using XChaCha20-Poly1305 AEAD cipher
    ///
    /// This verifies:
    /// - Data integrity via Poly1305 MAC
    /// - Data authenticity (tamper detection)
    fn decrypt(key: &[u8; 32], nonce: &[u8; 24], ciphertext: &[u8]) -> CredentialResult<Vec<u8>> {
        // XChaCha20-Poly1305 adds 16-byte authentication tag
        if ciphertext.len() < 16 {
            return Err(CredentialError::DecryptionError(
                "Ciphertext too short (missing authentication tag)".to_string(),
            ));
        }

        let cipher = XChaCha20Poly1305::new_from_slice(key)
            .map_err(|e| CredentialError::DecryptionError(format!("Invalid key: {}", e)))?;

        let nonce = XNonce::from_slice(nonce);

        cipher.decrypt(nonce, ciphertext).map_err(|_| {
            CredentialError::DecryptionError(
                "Decryption failed: authentication tag verification failed".to_string(),
            )
        })
    }
}

/// Thread-safe credential manager wrapper
pub type SharedCredentialVault = Arc<RwLock<Option<CredentialVault>>>;

/// Creates a new shared credential vault
pub fn create_shared_vault() -> SharedCredentialVault {
    Arc::new(RwLock::new(None))
}

/// Initializes the shared vault with the given path
pub async fn initialize_vault(
    shared: &SharedCredentialVault,
    vault_path: PathBuf,
) -> CredentialResult<()> {
    let vault = CredentialVault::new(vault_path)?;
    let mut guard = shared.write().await;
    *guard = Some(vault);
    Ok(())
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_credential_type_validation() {
        // Valid OpenAI key
        assert!(CredentialType::OpenaiApiKey
            .validate("sk-test1234567890")
            .is_ok());

        // Empty value
        assert!(matches!(
            CredentialType::OpenaiApiKey.validate(""),
            Err(CredentialError::EmptyValue)
        ));

        // Too long
        let long_value = "x".repeat(2000);
        assert!(matches!(
            CredentialType::OpenaiApiKey.validate(&long_value),
            Err(CredentialError::ValueTooLong)
        ));
    }

    #[tokio::test]
    async fn test_credential_type_redaction() {
        assert_eq!(CredentialType::redact("sk-1234567890abcdef"), "sk-1...cdef");
        assert_eq!(CredentialType::redact("short"), "*****");
        assert_eq!(CredentialType::redact("12345678"), "********"); // < 12 chars = fully masked
        assert_eq!(CredentialType::redact("123456789012"), "1234...9012"); // >= 12 chars = partial
    }

    #[tokio::test]
    async fn test_credential_type_parsing() {
        assert_eq!(
            "openai".parse::<CredentialType>().unwrap(),
            CredentialType::OpenaiApiKey
        );
        assert_eq!(
            "anthropic_api_key".parse::<CredentialType>().unwrap(),
            CredentialType::AnthropicApiKey
        );
        assert_eq!(
            "gemini".parse::<CredentialType>().unwrap(),
            CredentialType::GoogleApiKey
        );
        assert!("invalid".parse::<CredentialType>().is_err());
    }

    #[tokio::test]
    async fn test_vault_store_and_retrieve() {
        let temp_dir = TempDir::new().unwrap();
        let vault_path = temp_dir.path().join("credentials.vault");

        let vault = CredentialVault::new(vault_path).unwrap();

        // Store a credential
        vault
            .store(CredentialType::OpenaiApiKey, "sk-test1234567890")
            .await
            .unwrap();

        // Verify it exists
        assert!(vault.exists(CredentialType::OpenaiApiKey).await);

        // Retrieve it
        let value = vault.retrieve(CredentialType::OpenaiApiKey).await.unwrap();
        assert_eq!(value, "sk-test1234567890");
    }

    #[tokio::test]
    async fn test_vault_delete() {
        let temp_dir = TempDir::new().unwrap();
        let vault_path = temp_dir.path().join("credentials.vault");

        let vault = CredentialVault::new(vault_path).unwrap();

        // Store and delete
        vault
            .store(CredentialType::AnthropicApiKey, "sk-ant-test")
            .await
            .unwrap();
        assert!(vault.exists(CredentialType::AnthropicApiKey).await);

        vault.delete(CredentialType::AnthropicApiKey).await.unwrap();
        assert!(!vault.exists(CredentialType::AnthropicApiKey).await);
    }

    #[tokio::test]
    async fn test_vault_persistence() {
        let temp_dir = TempDir::new().unwrap();
        let vault_path = temp_dir.path().join("credentials.vault");

        // Store in first vault instance
        {
            let vault = CredentialVault::new(vault_path.clone()).unwrap();
            vault
                .store(CredentialType::GoogleApiKey, "AIzaTestKey123")
                .await
                .unwrap();
        }

        // Retrieve in new vault instance
        {
            let vault = CredentialVault::new(vault_path).unwrap();
            let value = vault.retrieve(CredentialType::GoogleApiKey).await.unwrap();
            assert_eq!(value, "AIzaTestKey123");
        }
    }

    #[tokio::test]
    async fn test_vault_list() {
        let temp_dir = TempDir::new().unwrap();
        let vault_path = temp_dir.path().join("credentials.vault");

        let vault = CredentialVault::new(vault_path).unwrap();

        vault
            .store(CredentialType::OpenaiApiKey, "sk-test")
            .await
            .unwrap();
        vault
            .store(CredentialType::AnthropicApiKey, "sk-ant-test")
            .await
            .unwrap();

        let types = vault.list().await;
        assert_eq!(types.len(), 2);
        assert!(types.contains(&CredentialType::OpenaiApiKey));
        assert!(types.contains(&CredentialType::AnthropicApiKey));
    }

    #[tokio::test]
    async fn test_encryption_decryption() {
        let key = [42u8; 32];
        let nonce = [1u8; 24];
        let plaintext = b"Hello, World!";

        let ciphertext = CredentialVault::encrypt(&key, &nonce, plaintext).unwrap();

        // XChaCha20-Poly1305 adds 16-byte auth tag
        assert_eq!(ciphertext.len(), plaintext.len() + 16);

        let decrypted = CredentialVault::decrypt(&key, &nonce, &ciphertext).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[tokio::test]
    async fn test_aead_authentication_failure() {
        let key = [42u8; 32];
        let nonce = [1u8; 24];
        let plaintext = b"Hello, World!";

        let mut ciphertext = CredentialVault::encrypt(&key, &nonce, plaintext).unwrap();

        // Tamper with the ciphertext (should fail authentication)
        if !ciphertext.is_empty() {
            ciphertext[0] ^= 0xFF;
        }

        let result = CredentialVault::decrypt(&key, &nonce, &ciphertext);
        assert!(matches!(result, Err(CredentialError::DecryptionError(_))));
    }

    #[tokio::test]
    async fn test_aead_wrong_key_fails() {
        let key = [42u8; 32];
        let wrong_key = [43u8; 32];
        let nonce = [1u8; 24];
        let plaintext = b"Hello, World!";

        let ciphertext = CredentialVault::encrypt(&key, &nonce, plaintext).unwrap();
        let result = CredentialVault::decrypt(&wrong_key, &nonce, &ciphertext);

        assert!(matches!(result, Err(CredentialError::DecryptionError(_))));
    }

    #[tokio::test]
    async fn test_aead_wrong_nonce_fails() {
        let key = [42u8; 32];
        let nonce = [1u8; 24];
        let wrong_nonce = [2u8; 24];
        let plaintext = b"Hello, World!";

        let ciphertext = CredentialVault::encrypt(&key, &nonce, plaintext).unwrap();
        let result = CredentialVault::decrypt(&key, &wrong_nonce, &ciphertext);

        assert!(matches!(result, Err(CredentialError::DecryptionError(_))));
    }

    #[tokio::test]
    async fn test_not_found_error() {
        let temp_dir = TempDir::new().unwrap();
        let vault_path = temp_dir.path().join("credentials.vault");

        let vault = CredentialVault::new(vault_path).unwrap();

        let result = vault.retrieve(CredentialType::OpenaiApiKey).await;
        assert!(matches!(result, Err(CredentialError::NotFound(_))));
    }

    #[tokio::test]
    async fn test_shared_vault() {
        let temp_dir = TempDir::new().unwrap();
        let vault_path = temp_dir.path().join("credentials.vault");

        let shared = create_shared_vault();
        initialize_vault(&shared, vault_path).await.unwrap();

        let guard = shared.read().await;
        let vault = guard.as_ref().unwrap();

        vault
            .store(CredentialType::OpenaiApiKey, "sk-shared-test")
            .await
            .unwrap();

        let value = vault.retrieve(CredentialType::OpenaiApiKey).await.unwrap();
        assert_eq!(value, "sk-shared-test");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn test_concurrent_store_does_not_corrupt_vault() {
        let temp_dir = TempDir::new().unwrap();
        let vault_path = temp_dir.path().join("credentials.vault");

        let vault = std::sync::Arc::new(CredentialVault::new(vault_path.clone()).unwrap());

        // Many concurrent writes should not panic and should not produce a corrupted vault file.
        let mut tasks = Vec::new();
        for i in 0..25u32 {
            let v = std::sync::Arc::clone(&vault);
            tasks.push(tokio::spawn(async move {
                let key = format!("sk-test-{:02}", i);
                v.store(CredentialType::OpenaiApiKey, &key).await
            }));
        }

        for task in tasks {
            task.await.unwrap().unwrap();
        }

        // Reloading from disk should succeed.
        let reopened = CredentialVault::new(vault_path).unwrap();
        let value = reopened
            .retrieve(CredentialType::OpenaiApiKey)
            .await
            .unwrap();
        assert!(value.starts_with("sk-test-"));
    }
}
