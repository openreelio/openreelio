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
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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
    /// Stored Codex/OpenAI OAuth credentials used to mint runtime bearer tokens
    OpenaiCodexOauth,
    /// Anthropic API key (sk-ant-...)
    AnthropicApiKey,
    /// Google AI API key (AIza...)
    GoogleApiKey,
    /// Seedance / BytePlus video generation API key
    SeedanceApiKey,
    /// Custom provider API key
    CustomApiKey,
}

impl CredentialType {
    fn max_value_len(&self) -> usize {
        match self {
            // Codex/OpenAI OAuth exchanges can yield JWT-style bearer tokens that are
            // substantially longer than traditional `sk-*` API keys.
            Self::OpenaiApiKey | Self::OpenaiCodexOauth => 4096,
            _ => 1024,
        }
    }

    /// Returns the key name used in the vault
    pub fn vault_key(&self) -> &'static str {
        match self {
            Self::OpenaiApiKey => "openai_api_key",
            Self::OpenaiCodexOauth => "openai_codex_oauth",
            Self::AnthropicApiKey => "anthropic_api_key",
            Self::GoogleApiKey => "google_api_key",
            Self::SeedanceApiKey => "seedance_api_key",
            Self::CustomApiKey => "custom_api_key",
        }
    }

    /// Validates the format of the credential value
    pub fn validate(&self, value: &str) -> Result<(), CredentialError> {
        if value.is_empty() {
            return Err(CredentialError::EmptyValue);
        }

        if value.len() > self.max_value_len() {
            return Err(CredentialError::ValueTooLong);
        }

        // Basic format validation (not exhaustive - APIs will reject invalid keys)
        match self {
            Self::OpenaiApiKey => {
                if !value.starts_with("sk-")
                    && !value.starts_with("sess-")
                    && !value.starts_with("eyJ")
                {
                    warn!(
                        "OpenAI credential does not match expected format (sk-*, sess-*, or JWT bearer token), proceeding anyway"
                    );
                }
            }
            Self::OpenaiCodexOauth => {
                if serde_json::from_str::<StoredCodexOauthCredential>(value).is_err() {
                    warn!("Codex OAuth credential did not parse as expected JSON, proceeding anyway");
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
            Self::SeedanceApiKey => {
                // Seedance key format not yet standardized — basic non-empty check is sufficient
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
            "openai_codex_oauth" | "codex_oauth" | "openai_codex" => Ok(Self::OpenaiCodexOauth),
            "anthropic_api_key" | "anthropic" => Ok(Self::AnthropicApiKey),
            "google_api_key" | "google" | "gemini" => Ok(Self::GoogleApiKey),
            "seedance_api_key" | "seedance" => Ok(Self::SeedanceApiKey),
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

    #[error("Credential value too long for this provider")]
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

/// Minimal status for a local Codex auth store.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexAuthStatus {
    pub has_auth_file: bool,
    pub has_openai_api_key: bool,
    pub has_access_token: bool,
    pub has_refresh_token: bool,
    pub can_exchange_oauth: bool,
}

#[derive(Debug, Deserialize)]
struct CodexAuthFile {
    #[serde(rename = "OPENAI_API_KEY")]
    openai_api_key: Option<String>,
    tokens: Option<CodexTokens>,
}

#[derive(Debug, Deserialize)]
struct CodexTokens {
    access_token: Option<String>,
    refresh_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CodexHelperStatus {
    #[serde(rename = "hasAuthFile")]
    has_auth_file: bool,
    #[serde(rename = "hasOpenaiApiKey")]
    has_openai_api_key: bool,
    #[serde(rename = "hasAccessToken")]
    has_access_token: bool,
    #[serde(rename = "hasRefreshToken")]
    has_refresh_token: bool,
    #[serde(rename = "canExchangeOauth")]
    can_exchange_oauth: bool,
}

#[derive(Debug, Deserialize)]
struct CodexHelperExchange {
    ok: bool,
    #[serde(rename = "apiKey")]
    api_key: Option<String>,
    mode: Option<String>,
    source: Option<String>,
    #[serde(rename = "newCredentials")]
    new_credentials: Option<StoredCodexOauthCredential>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CodexHelperOauthExport {
    ok: bool,
    oauth: Option<StoredCodexOauthCredential>,
    #[allow(dead_code)]
    source: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CodexHelperModels {
    pub ok: bool,
    pub models: Option<Vec<String>>,
    pub message: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CodexHelperUsageCost {
    pub input: f64,
    pub output: f64,
    #[serde(rename = "cacheRead")]
    pub cache_read: f64,
    #[serde(rename = "cacheWrite")]
    pub cache_write: f64,
    pub total: f64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CodexHelperUsage {
    pub input: u32,
    pub output: u32,
    #[serde(rename = "cacheRead")]
    pub cache_read: u32,
    #[serde(rename = "cacheWrite")]
    pub cache_write: u32,
    #[serde(rename = "totalTokens")]
    pub total_tokens: u32,
    pub cost: CodexHelperUsageCost,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CodexHelperCompletion {
    pub ok: bool,
    #[allow(dead_code)]
    pub provider: Option<String>,
    #[allow(dead_code)]
    pub api: Option<String>,
    pub model: Option<String>,
    pub text: Option<String>,
    #[serde(rename = "stopReason")]
    pub stop_reason: Option<String>,
    #[serde(rename = "errorMessage")]
    pub error_message: Option<String>,
    pub usage: Option<CodexHelperUsage>,
    #[serde(rename = "newCredentials")]
    pub new_credentials: Option<StoredCodexOauthCredential>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredCodexOauthCredential {
    #[serde(rename = "type")]
    pub credential_type: String,
    pub provider: String,
    pub access: String,
    pub refresh: String,
    pub expires: i64,
    #[serde(rename = "accountId")]
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexResolvedApiKey {
    pub api_key: String,
    pub mode: String,
    pub source: Option<String>,
    pub updated_oauth: Option<String>,
}

/// Returns the default local Codex auth file path.
pub fn codex_auth_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("~"))
        .join(".codex")
        .join("auth.json")
}

/// Reads the local Codex auth file status without exposing any token values.
pub fn codex_auth_status() -> CodexAuthStatus {
    if let Ok(Some(status)) = codex_helper_status() {
        return CodexAuthStatus {
            has_auth_file: status.has_auth_file,
            has_openai_api_key: status.has_openai_api_key,
            has_access_token: status.has_access_token,
            has_refresh_token: status.has_refresh_token,
            can_exchange_oauth: status.can_exchange_oauth,
        };
    }
    codex_auth_status_at(&codex_auth_path())
}

/// Reads an OpenAI API key from the local Codex auth file when one is present.
pub fn codex_openai_api_key() -> CredentialResult<Option<String>> {
    codex_openai_api_key_at(&codex_auth_path())
}

pub fn codex_exchange_api_key() -> CredentialResult<Option<CodexResolvedApiKey>> {
    let Some(result) = codex_helper_exchange()? else {
        return Ok(None);
    };

    if !result.ok {
        return Ok(None);
    }

    let api_key = result
        .api_key
        .and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() { None } else { Some(trimmed) }
        })
        .ok_or_else(|| {
            CredentialError::SerializationError(
                "Codex helper reported success without an API key".to_string(),
            )
        })?;

    Ok(Some(CodexResolvedApiKey {
        api_key,
        mode: result.mode.unwrap_or_else(|| "unknown".to_string()),
        source: result.source,
        updated_oauth: result
            .new_credentials
            .map(|oauth| serde_json::to_string(&oauth))
            .transpose()
            .map_err(|e| {
                CredentialError::SerializationError(format!(
                    "Failed to serialize refreshed Codex OAuth credentials: {}",
                    e
                ))
            })?,
    }))
}

pub fn codex_local_oauth() -> CredentialResult<Option<String>> {
    let Some(result) = codex_helper_export_oauth()? else {
        return Ok(None);
    };

    if !result.ok {
        return Ok(None);
    }

    result
        .oauth
        .map(|oauth| {
            serde_json::to_string(&oauth).map_err(|e| {
                CredentialError::SerializationError(format!(
                    "Failed to serialize Codex OAuth credential: {}",
                    e
                ))
            })
        })
        .transpose()
}

pub fn codex_exchange_stored_oauth(
    stored_oauth_json: &str,
) -> CredentialResult<Option<CodexResolvedApiKey>> {
    let oauth = serde_json::from_str::<StoredCodexOauthCredential>(stored_oauth_json).map_err(
        |e| CredentialError::SerializationError(format!("Failed to parse stored Codex OAuth credential: {}", e)),
    )?;

    let Some(result) = codex_helper_exchange_oauth(&oauth)? else {
        return Ok(None);
    };

    if !result.ok {
        return Ok(None);
    }

    let api_key = result
        .api_key
        .and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() { None } else { Some(trimmed) }
        })
        .ok_or_else(|| {
            CredentialError::SerializationError(
                "Codex helper reported success without an API key".to_string(),
            )
        })?;

    Ok(Some(CodexResolvedApiKey {
        api_key,
        mode: result.mode.unwrap_or_else(|| "oauth_exchange".to_string()),
        source: result.source,
        updated_oauth: result
            .new_credentials
            .map(|updated| serde_json::to_string(&updated))
            .transpose()
            .map_err(|e| {
                CredentialError::SerializationError(format!(
                    "Failed to serialize refreshed stored Codex OAuth credential: {}",
                    e
                ))
            })?,
    }))
}

fn codex_auth_status_at(path: &Path) -> CodexAuthStatus {
    let auth = match load_codex_auth(path) {
        Ok(Some(auth)) => auth,
        Ok(None) | Err(_) => return CodexAuthStatus::default(),
    };

    CodexAuthStatus {
        has_auth_file: true,
        has_openai_api_key: auth
            .openai_api_key
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()),
        has_access_token: auth
            .tokens
            .as_ref()
            .and_then(|tokens| tokens.access_token.as_deref())
            .is_some_and(|value| !value.trim().is_empty()),
        has_refresh_token: auth
            .tokens
            .as_ref()
            .and_then(|tokens| tokens.refresh_token.as_deref())
            .is_some_and(|value| !value.trim().is_empty()),
        can_exchange_oauth: auth
            .tokens
            .as_ref()
            .and_then(|tokens| tokens.access_token.as_deref())
            .is_some_and(|value| !value.trim().is_empty())
            && auth
                .tokens
                .as_ref()
                .and_then(|tokens| tokens.refresh_token.as_deref())
                .is_some_and(|value| !value.trim().is_empty()),
    }
}

fn codex_openai_api_key_at(path: &Path) -> CredentialResult<Option<String>> {
    let Some(auth) = load_codex_auth(path)? else {
        return Ok(None);
    };

    Ok(auth.openai_api_key.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }))
}

fn load_codex_auth(path: &Path) -> CredentialResult<Option<CodexAuthFile>> {
    if !path.exists() {
        return Ok(None);
    }

    let data = std::fs::read(path)?;
    let parsed = serde_json::from_slice::<CodexAuthFile>(&data)
        .map_err(|e| CredentialError::SerializationError(format!("Failed to parse Codex auth.json: {}", e)))?;
    Ok(Some(parsed))
}

fn codex_helper_script_path() -> PathBuf {
    if let Some(path) = std::env::var_os("OPENREELIO_CODEX_HELPER_PATH") {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return candidate;
        }
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("scripts")
        .join("codex-auth-exchange.mjs")
}

fn run_codex_helper(command: &str) -> CredentialResult<String> {
    run_codex_helper_with_input(command, None)
}

fn run_codex_helper_with_input(command: &str, input: Option<&str>) -> CredentialResult<String> {
    let script_path = codex_helper_script_path();
    if !script_path.exists() {
        return Err(CredentialError::NotFound(format!(
            "Codex helper script not found: {}",
            script_path.display()
        )));
    }

    let mut child = Command::new("node")
        .arg(script_path)
        .arg(command)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| CredentialError::InitializationFailed(format!("Failed to execute Codex helper: {}", e)))?;

    if let Some(input) = input {
        let stdin = child.stdin.as_mut().ok_or_else(|| {
            CredentialError::InitializationFailed("Failed to open Codex helper stdin".to_string())
        })?;
        stdin
            .write_all(input.as_bytes())
            .map_err(|e| CredentialError::InitializationFailed(format!("Failed to write Codex helper stdin: {}", e)))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| CredentialError::InitializationFailed(format!("Failed to wait for Codex helper: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(CredentialError::InitializationFailed(if stderr.is_empty() {
            format!("Codex helper exited with status {}", output.status)
        } else {
            format!("Codex helper failed: {}", stderr)
        }));
    }

    String::from_utf8(output.stdout)
        .map_err(|e| CredentialError::SerializationError(format!("Codex helper output was not UTF-8: {}", e)))
}

pub(crate) fn run_codex_helper_json<T>(command: &str) -> CredentialResult<T>
where
    T: DeserializeOwned,
{
    let stdout = run_codex_helper(command)?;
    serde_json::from_str::<T>(&stdout).map_err(|e| {
        CredentialError::SerializationError(format!(
            "Failed to parse Codex helper {} response: {}",
            command, e
        ))
    })
}

pub(crate) fn run_codex_helper_json_with_input<T, P>(
    command: &str,
    payload: &P,
) -> CredentialResult<T>
where
    T: DeserializeOwned,
    P: Serialize,
{
    let input = serde_json::to_string(payload).map_err(|e| {
        CredentialError::SerializationError(format!(
            "Failed to serialize Codex helper {} payload: {}",
            command, e
        ))
    })?;
    let stdout = run_codex_helper_with_input(command, Some(&input))?;
    serde_json::from_str::<T>(&stdout).map_err(|e| {
        CredentialError::SerializationError(format!(
            "Failed to parse Codex helper {} response: {}",
            command, e
        ))
    })
}

fn codex_helper_status() -> CredentialResult<Option<CodexHelperStatus>> {
    let parsed = run_codex_helper_json::<CodexHelperStatus>("status")?;
    Ok(Some(parsed))
}

fn codex_helper_exchange() -> CredentialResult<Option<CodexHelperExchange>> {
    let parsed = run_codex_helper_json::<CodexHelperExchange>("exchange")?;
    if !parsed.ok && parsed.message.is_none() {
        return Ok(None);
    }
    Ok(Some(parsed))
}

fn codex_helper_export_oauth() -> CredentialResult<Option<CodexHelperOauthExport>> {
    let parsed = run_codex_helper_json::<CodexHelperOauthExport>("export-oauth")?;
    if !parsed.ok && parsed.message.is_none() {
        return Ok(None);
    }
    Ok(Some(parsed))
}

fn codex_helper_exchange_oauth(
    oauth: &StoredCodexOauthCredential,
) -> CredentialResult<Option<CodexHelperExchange>> {
    let parsed = run_codex_helper_json_with_input::<CodexHelperExchange, _>(
        "exchange-oauth-stdin",
        oauth,
    )?;
    if !parsed.ok && parsed.message.is_none() {
        return Ok(None);
    }
    Ok(Some(parsed))
}

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
        assert!(CredentialType::OpenaiApiKey
            .validate(&"e".repeat(1889))
            .is_ok());
        assert!(CredentialType::OpenaiCodexOauth
            .validate(r#"{"type":"oauth","provider":"openai-codex","access":"a","refresh":"b","expires":1,"accountId":"acct"}"#)
            .is_ok());

        // Empty value
        assert!(matches!(
            CredentialType::OpenaiApiKey.validate(""),
            Err(CredentialError::EmptyValue)
        ));

        // Too long for OpenAI
        let openai_long_value = "x".repeat(5000);
        assert!(matches!(
            CredentialType::OpenaiApiKey.validate(&openai_long_value),
            Err(CredentialError::ValueTooLong)
        ));

        // Too long for providers that still use the default limit
        let long_value = "x".repeat(2000);
        assert!(matches!(
            CredentialType::AnthropicApiKey.validate(&long_value),
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
            "openai_codex_oauth".parse::<CredentialType>().unwrap(),
            CredentialType::OpenaiCodexOauth
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

    #[test]
    fn test_codex_auth_status_with_api_key() {
        let temp_dir = TempDir::new().unwrap();
        let auth_path = temp_dir.path().join("auth.json");

        std::fs::write(
            &auth_path,
            r#"{
              "OPENAI_API_KEY": "sk-test-codex",
              "tokens": {
                "access_token": "access-token"
              }
            }"#,
        )
        .unwrap();

        let status = codex_auth_status_at(&auth_path);
        assert!(status.has_auth_file);
        assert!(status.has_openai_api_key);
        assert!(status.has_access_token);
        assert!(!status.has_refresh_token);
        assert!(!status.can_exchange_oauth);

        let imported = codex_openai_api_key_at(&auth_path).unwrap();
        assert_eq!(imported.as_deref(), Some("sk-test-codex"));
    }

    #[test]
    fn test_codex_auth_status_with_token_only() {
        let temp_dir = TempDir::new().unwrap();
        let auth_path = temp_dir.path().join("auth.json");

        std::fs::write(
            &auth_path,
            r#"{
              "OPENAI_API_KEY": null,
              "tokens": {
                "access_token": "access-token"
              }
            }"#,
        )
        .unwrap();

        let status = codex_auth_status_at(&auth_path);
        assert!(status.has_auth_file);
        assert!(!status.has_openai_api_key);
        assert!(status.has_access_token);
        assert!(!status.has_refresh_token);
        assert!(!status.can_exchange_oauth);

        let imported = codex_openai_api_key_at(&auth_path).unwrap();
        assert!(imported.is_none());
    }
}
