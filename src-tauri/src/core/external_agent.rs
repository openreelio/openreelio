//! External agent runtime helpers.
//!
//! This module owns runtime-only approval grants used when an external agent host
//! needs to apply an OpenReelio edit plan. Tokens are bearer credentials, so they
//! are intentionally short-lived and never persisted to project state.

use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use tokio::time::{timeout, Duration};
use uuid::Uuid;

pub const PLAN_APPLY_SCOPE: &str = "openreelio.plan.apply";
pub const DEFAULT_APPROVAL_TOKEN_TTL_MS: i64 = 10 * 60 * 1000;
pub const MIN_APPROVAL_TOKEN_TTL_MS: i64 = 5 * 1000;
pub const MAX_APPROVAL_TOKEN_TTL_MS: i64 = 30 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateExternalAgentApprovalTokenInput {
    pub session_id: String,
    pub run_id: Option<String>,
    pub plan_id: Option<String>,
    pub project_id: String,
    pub runtime_id: String,
    pub scopes: Vec<String>,
    pub ttl_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConsumeExternalAgentApprovalTokenInput {
    pub token: String,
    pub session_id: String,
    pub plan_id: Option<String>,
    pub project_id: String,
    pub runtime_id: String,
    pub required_scope: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RevokeExternalAgentApprovalTokenInput {
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RevokeExternalAgentApprovalTokenResult {
    pub revoked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentSetupInfoInput {
    pub project_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentSetupInfo {
    pub codex_login_command: String,
    pub codex_plugin_marketplace_root: Option<String>,
    pub codex_plugin_marketplace_command: Option<String>,
    pub codex_mcp_command: Option<String>,
    pub codex_mcp_command_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureCodexAgentRuntimeInput {
    pub project_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureCodexAgentRuntimeResult {
    pub installed: bool,
    pub version: Option<String>,
    pub auth_status: String,
    pub ready: bool,
    pub requires_login: bool,
    pub plugin_marketplace_configured: bool,
    pub mcp_configured: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexAgentLoginResult {
    pub success: bool,
    pub auth_status: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentApprovalTokenGrant {
    pub token: String,
    pub token_id: String,
    pub session_id: String,
    pub run_id: Option<String>,
    pub plan_id: Option<String>,
    pub project_id: String,
    pub runtime_id: String,
    pub scopes: Vec<String>,
    pub created_at: i64,
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentApprovalTokenInfo {
    pub token_id: String,
    pub session_id: String,
    pub run_id: Option<String>,
    pub plan_id: Option<String>,
    pub project_id: String,
    pub runtime_id: String,
    pub scopes: Vec<String>,
    pub created_at: i64,
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentApprovalTokenValidation {
    pub valid: bool,
    pub reason: Option<String>,
    pub grant: Option<ExternalAgentApprovalTokenInfo>,
}

#[derive(Debug, Default)]
pub struct ExternalAgentApprovalTokenStore {
    tokens: HashMap<String, ExternalAgentApprovalTokenInfo>,
}

pub fn build_external_agent_setup_info(
    input: ExternalAgentSetupInfoInput,
) -> ExternalAgentSetupInfo {
    let marketplace_root = find_repo_agents_root();
    let codex_command = quote_command_arg(&crate::core::codex::codex_command_label());
    let codex_plugin_marketplace_command = marketplace_root.as_ref().map(|root| {
        format!(
            "{codex_command} plugin marketplace add {}",
            quote_command_arg(root)
        )
    });

    let project_path = input
        .project_path
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty());
    let codex_mcp_command = project_path.as_ref().map(|project_path| {
        let cli_command = find_openreelio_cli_command();
        format!(
            "{codex_command} mcp add openreelio --env {} -- {} mcp --stdio --project {}",
            quote_command_arg(&format!("OPENREELIO_PROJECT_PATH={project_path}")),
            cli_command,
            quote_command_arg(project_path)
        )
    });
    let codex_mcp_command_reason = if codex_mcp_command.is_some() {
        None
    } else {
        Some("Open a project to generate a project-scoped MCP command.".to_string())
    };

    ExternalAgentSetupInfo {
        codex_login_command: format!("{codex_command} login"),
        codex_plugin_marketplace_root: marketplace_root,
        codex_plugin_marketplace_command,
        codex_mcp_command,
        codex_mcp_command_reason,
    }
}

pub async fn configure_codex_agent_runtime(
    input: ConfigureCodexAgentRuntimeInput,
) -> ConfigureCodexAgentRuntimeResult {
    let status = crate::core::codex::probe_codex_status().await;
    if !status.installed {
        return ConfigureCodexAgentRuntimeResult {
            installed: false,
            version: status.version,
            auth_status: status.auth_status,
            ready: false,
            requires_login: false,
            plugin_marketplace_configured: false,
            mcp_configured: false,
            message: status
                .reason
                .or_else(|| Some("Codex CLI is not installed.".to_string())),
        };
    }

    let authenticated = is_authenticated(&status.auth_status);
    let plugin_result = configure_codex_plugin_marketplace().await;
    let mcp_result = match input
        .project_path
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
    {
        Some(project_path) => configure_codex_mcp(&project_path).await,
        None => Err("Open a project before enabling OpenReelio tools for Codex.".to_string()),
    };

    let plugin_marketplace_configured = plugin_result.is_ok();
    let mcp_configured = mcp_result.is_ok();
    let ready = authenticated && plugin_marketplace_configured && mcp_configured;
    let message = if ready {
        Some("Codex is connected with OpenReelio tools.".to_string())
    } else if !authenticated {
        status
            .reason
            .or_else(|| Some("Codex needs sign-in.".to_string()))
    } else {
        plugin_result.err().or_else(|| mcp_result.err())
    };

    ConfigureCodexAgentRuntimeResult {
        installed: true,
        version: status.version,
        auth_status: status.auth_status,
        ready,
        requires_login: !authenticated,
        plugin_marketplace_configured,
        mcp_configured,
        message,
    }
}

pub async fn start_codex_login() -> CodexAgentLoginResult {
    let before = crate::core::codex::probe_codex_status().await;
    if is_authenticated(&before.auth_status) {
        return CodexAgentLoginResult {
            success: true,
            auth_status: before.auth_status,
            message: Some("Codex is already signed in.".to_string()),
        };
    }
    if !before.installed {
        return CodexAgentLoginResult {
            success: false,
            auth_status: before.auth_status,
            message: before
                .reason
                .or_else(|| Some("Codex CLI is not installed.".to_string())),
        };
    }

    let login_result = run_codex_command(&["login"], &[], Duration::from_secs(300)).await;
    let after = crate::core::codex::probe_codex_status().await;
    let success = is_authenticated(&after.auth_status);

    CodexAgentLoginResult {
        success,
        auth_status: after.auth_status,
        message: if success {
            Some("Codex sign-in completed.".to_string())
        } else {
            Some(match login_result {
                Ok(output) if output.is_empty() => "Codex sign-in did not complete.".to_string(),
                Ok(output) => output,
                Err(error) => error,
            })
        },
    }
}

impl ExternalAgentApprovalTokenStore {
    pub fn issue(
        &mut self,
        input: CreateExternalAgentApprovalTokenInput,
        now_ms: i64,
    ) -> Result<ExternalAgentApprovalTokenGrant, String> {
        self.reap_expired(now_ms);

        let session_id = required_field("sessionId", input.session_id)?;
        let project_id = required_field("projectId", input.project_id)?;
        let runtime_id = required_field("runtimeId", input.runtime_id)?;
        let run_id = optional_non_empty(input.run_id);
        let plan_id = optional_non_empty(input.plan_id);
        let scopes = normalize_scopes(input.scopes)?;

        if scopes.iter().any(|scope| scope == PLAN_APPLY_SCOPE) && plan_id.is_none() {
            return Err("planId is required for openreelio.plan.apply approval tokens".to_string());
        }

        let ttl_ms = normalize_ttl_ms(input.ttl_ms);
        let token = generate_secure_token();
        let info = ExternalAgentApprovalTokenInfo {
            token_id: Uuid::new_v4().to_string(),
            session_id,
            run_id,
            plan_id,
            project_id,
            runtime_id,
            scopes,
            created_at: now_ms,
            expires_at: now_ms + ttl_ms,
        };

        self.tokens.insert(token.clone(), info.clone());

        Ok(ExternalAgentApprovalTokenGrant {
            token,
            token_id: info.token_id,
            session_id: info.session_id,
            run_id: info.run_id,
            plan_id: info.plan_id,
            project_id: info.project_id,
            runtime_id: info.runtime_id,
            scopes: info.scopes,
            created_at: info.created_at,
            expires_at: info.expires_at,
        })
    }

    pub fn consume(
        &mut self,
        input: ConsumeExternalAgentApprovalTokenInput,
        now_ms: i64,
    ) -> ExternalAgentApprovalTokenValidation {
        self.reap_expired(now_ms);

        let token = input.token.trim();
        let Some(info) = self.tokens.get(token).cloned() else {
            return invalid_validation("approvalToken is invalid or expired");
        };

        if info.expires_at <= now_ms {
            self.tokens.remove(token);
            return invalid_validation("approvalToken is expired");
        }

        let required_scope = input.required_scope.trim();
        if required_scope.is_empty() {
            return invalid_validation("requiredScope is required");
        }
        if !info.scopes.iter().any(|scope| scope == required_scope) {
            return invalid_validation("approvalToken does not include the required scope");
        }

        let expected = ApprovalTokenContext {
            session_id: input.session_id.trim(),
            project_id: input.project_id.trim(),
            runtime_id: input.runtime_id.trim(),
            plan_id: optional_non_empty(input.plan_id),
        };

        if info.session_id != expected.session_id
            || info.project_id != expected.project_id
            || info.runtime_id != expected.runtime_id
            || info.plan_id != expected.plan_id
        {
            return invalid_validation("approvalToken context does not match the approved request");
        }

        self.tokens.remove(token);
        ExternalAgentApprovalTokenValidation {
            valid: true,
            reason: None,
            grant: Some(info),
        }
    }

    pub fn revoke(&mut self, token: &str, now_ms: i64) -> bool {
        self.reap_expired(now_ms);
        self.tokens.remove(token.trim()).is_some()
    }

    pub fn active_count(&mut self, now_ms: i64) -> usize {
        self.reap_expired(now_ms);
        self.tokens.len()
    }

    fn reap_expired(&mut self, now_ms: i64) {
        self.tokens
            .retain(|_, token_info| token_info.expires_at > now_ms);
    }
}

struct ApprovalTokenContext<'a> {
    session_id: &'a str,
    project_id: &'a str,
    runtime_id: &'a str,
    plan_id: Option<String>,
}

fn normalize_ttl_ms(ttl_ms: Option<i64>) -> i64 {
    ttl_ms
        .unwrap_or(DEFAULT_APPROVAL_TOKEN_TTL_MS)
        .clamp(MIN_APPROVAL_TOKEN_TTL_MS, MAX_APPROVAL_TOKEN_TTL_MS)
}

fn required_field(name: &str, value: String) -> Result<String, String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        Err(format!("{name} is required"))
    } else {
        Ok(value)
    }
}

fn optional_non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_scopes(scopes: Vec<String>) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let normalized = scopes
        .into_iter()
        .map(|scope| scope.trim().to_string())
        .filter(|scope| !scope.is_empty())
        .filter(|scope| seen.insert(scope.clone()))
        .collect::<Vec<_>>();

    if normalized.is_empty() {
        Err("At least one approval scope is required".to_string())
    } else {
        Ok(normalized)
    }
}

fn generate_secure_token() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);

    let mut token = String::with_capacity("or_mcp_".len() + bytes.len() * 2);
    token.push_str("or_mcp_");
    for byte in bytes {
        let _ = write!(&mut token, "{byte:02x}");
    }
    token
}

fn find_repo_agents_root() -> Option<String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.parent().unwrap_or(manifest_dir.as_path());
    let agents_root = repo_root.join(".agents");
    if !agents_root.is_dir() {
        return None;
    }

    Some(display_path(&agents_root))
}

fn find_openreelio_cli_command() -> String {
    quote_command_arg(&find_openreelio_cli_executable())
}

fn find_openreelio_cli_executable() -> String {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.parent().unwrap_or(manifest_dir.as_path());
    let cli_binary = repo_root
        .join("target")
        .join("debug")
        .join(if cfg!(windows) {
            "openreelio-cli.exe"
        } else {
            "openreelio-cli"
        });

    if cli_binary.is_file() {
        display_path(&cli_binary)
    } else {
        "openreelio-cli".to_string()
    }
}

fn display_path(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .display()
        .to_string()
}

fn quote_command_arg(value: &str) -> String {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/' | ':' | '='))
    {
        return value.to_string();
    }

    format!("'{}'", value.replace('\'', "'\\''"))
}

fn is_authenticated(auth_status: &str) -> bool {
    matches!(auth_status, "signed-in" | "api-key")
}

async fn configure_codex_plugin_marketplace() -> Result<(), String> {
    let marketplace_root = find_repo_agents_root()
        .ok_or_else(|| "OpenReelio plugin marketplace was not found.".to_string())?;
    let args = vec![
        "plugin".to_string(),
        "marketplace".to_string(),
        "add".to_string(),
        marketplace_root,
    ];

    run_codex_command_owned(args, &[], Duration::from_secs(30))
        .await
        .map(|_| ())
        .or_else(|error| {
            if is_already_configured_error(&error) {
                Ok(())
            } else {
                Err(error)
            }
        })
}

async fn configure_codex_mcp(project_path: &str) -> Result<(), String> {
    let _ = run_codex_command(
        &["mcp", "remove", "openreelio"],
        &[],
        Duration::from_secs(15),
    )
    .await;

    let args = vec![
        "mcp".to_string(),
        "add".to_string(),
        "openreelio".to_string(),
        "--env".to_string(),
        format!("OPENREELIO_PROJECT_PATH={project_path}"),
        "--".to_string(),
        find_openreelio_cli_executable(),
        "mcp".to_string(),
        "--stdio".to_string(),
        "--project".to_string(),
        project_path.to_string(),
    ];

    run_codex_command_owned(args, &[], Duration::from_secs(30))
        .await
        .map(|_| ())
}

async fn run_codex_command(
    args: &[&str],
    envs: &[(&str, &str)],
    timeout_duration: Duration,
) -> Result<String, String> {
    run_codex_command_owned(
        args.iter().map(|arg| (*arg).to_string()).collect(),
        envs,
        timeout_duration,
    )
    .await
}

async fn run_codex_command_owned(
    args: Vec<String>,
    envs: &[(&str, &str)],
    timeout_duration: Duration,
) -> Result<String, String> {
    let mut command = crate::core::codex::create_codex_command()?;
    command.args(args).stdin(std::process::Stdio::null());
    for (key, value) in envs {
        command.env(key, value);
    }

    let output = timeout(timeout_duration, command.output())
        .await
        .map_err(|_| "Codex command timed out.".to_string())?
        .map_err(|error| {
            crate::core::codex::format_codex_io_error("Failed to run Codex command", &error)
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    if output.status.success() {
        Ok(combined)
    } else if combined.is_empty() {
        Err(format!(
            "Codex command failed with status {}",
            output.status
        ))
    } else {
        Err(combined)
    }
}

fn is_already_configured_error(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("already") || lower.contains("exists")
}

fn invalid_validation(reason: impl Into<String>) -> ExternalAgentApprovalTokenValidation {
    ExternalAgentApprovalTokenValidation {
        valid: false,
        reason: Some(reason.into()),
        grant: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan_apply_input() -> CreateExternalAgentApprovalTokenInput {
        CreateExternalAgentApprovalTokenInput {
            session_id: "session-1".to_string(),
            run_id: Some("run-1".to_string()),
            plan_id: Some("plan-1".to_string()),
            project_id: "project-1".to_string(),
            runtime_id: "codex".to_string(),
            scopes: vec![PLAN_APPLY_SCOPE.to_string()],
            ttl_ms: None,
        }
    }

    fn consume_input(token: String) -> ConsumeExternalAgentApprovalTokenInput {
        ConsumeExternalAgentApprovalTokenInput {
            token,
            session_id: "session-1".to_string(),
            plan_id: Some("plan-1".to_string()),
            project_id: "project-1".to_string(),
            runtime_id: "codex".to_string(),
            required_scope: PLAN_APPLY_SCOPE.to_string(),
        }
    }

    #[test]
    fn should_build_codex_setup_commands_with_project_path() {
        let info = build_external_agent_setup_info(ExternalAgentSetupInfoInput {
            project_path: Some("/tmp/OpenReelio Project".to_string()),
        });

        assert!(info.codex_login_command.ends_with(" login"));
        assert_eq!(info.codex_mcp_command_reason, None);
        let command = info.codex_mcp_command.expect("mcp command");
        assert!(command.contains(" mcp add openreelio"));
        assert!(command.contains("'OPENREELIO_PROJECT_PATH=/tmp/OpenReelio Project'"));
        assert!(command.contains(" mcp --stdio --project '/tmp/OpenReelio Project'"));
    }

    #[test]
    fn should_explain_missing_project_path_for_codex_mcp_command() {
        let info =
            build_external_agent_setup_info(ExternalAgentSetupInfoInput { project_path: None });

        assert_eq!(info.codex_mcp_command, None);
        assert_eq!(
            info.codex_mcp_command_reason,
            Some("Open a project to generate a project-scoped MCP command.".to_string())
        );
    }

    #[test]
    fn issues_plan_apply_token_scoped_to_session_project_runtime_and_plan() {
        let mut store = ExternalAgentApprovalTokenStore::default();
        let now_ms = 1_000;

        let grant = store.issue(plan_apply_input(), now_ms).expect("grant");

        assert!(grant.token.starts_with("or_mcp_"));
        assert!(grant.token.len() > 32);
        assert_eq!(grant.session_id, "session-1");
        assert_eq!(grant.run_id.as_deref(), Some("run-1"));
        assert_eq!(grant.plan_id.as_deref(), Some("plan-1"));
        assert_eq!(grant.project_id, "project-1");
        assert_eq!(grant.runtime_id, "codex");
        assert_eq!(grant.scopes, vec![PLAN_APPLY_SCOPE.to_string()]);
        assert_eq!(grant.created_at, now_ms);
        assert_eq!(grant.expires_at, now_ms + DEFAULT_APPROVAL_TOKEN_TTL_MS);
        assert_eq!(store.active_count(now_ms), 1);
    }

    #[test]
    fn requires_plan_id_for_plan_apply_scope() {
        let mut store = ExternalAgentApprovalTokenStore::default();
        let mut input = plan_apply_input();
        input.plan_id = None;

        let error = store.issue(input, 1_000).expect_err("plan id error");

        assert!(error.contains("planId is required"));
    }

    #[test]
    fn clamps_approval_ttl_to_the_safe_runtime_window() {
        let mut store = ExternalAgentApprovalTokenStore::default();
        let mut input = plan_apply_input();
        input.ttl_ms = Some(24 * 60 * 60 * 1000);

        let grant = store.issue(input, 2_000).expect("grant");

        assert_eq!(grant.expires_at, 2_000 + MAX_APPROVAL_TOKEN_TTL_MS);
    }

    #[test]
    fn consumes_valid_token_once() {
        let mut store = ExternalAgentApprovalTokenStore::default();
        let grant = store.issue(plan_apply_input(), 1_000).expect("grant");

        let first = store.consume(consume_input(grant.token.clone()), 2_000);
        let second = store.consume(consume_input(grant.token.clone()), 2_001);

        assert!(first.valid);
        assert_eq!(
            first.grant.as_ref().map(|grant| grant.token_id.as_str()),
            Some(grant.token_id.as_str())
        );
        assert!(!second.valid);
        assert_eq!(store.active_count(2_001), 0);
    }

    #[test]
    fn rejects_context_mismatch_without_consuming_token() {
        let mut store = ExternalAgentApprovalTokenStore::default();
        let grant = store.issue(plan_apply_input(), 1_000).expect("grant");
        let mut wrong_context = consume_input(grant.token.clone());
        wrong_context.plan_id = Some("other-plan".to_string());

        let rejected = store.consume(wrong_context, 2_000);
        let accepted = store.consume(consume_input(grant.token), 2_001);

        assert!(!rejected.valid);
        assert!(rejected
            .reason
            .as_deref()
            .unwrap_or_default()
            .contains("context"));
        assert!(accepted.valid);
    }

    #[test]
    fn expires_tokens_and_rejects_late_consumption() {
        let mut store = ExternalAgentApprovalTokenStore::default();
        let mut input = plan_apply_input();
        input.ttl_ms = Some(MIN_APPROVAL_TOKEN_TTL_MS);
        let grant = store.issue(input, 1_000).expect("grant");

        let rejected = store.consume(
            consume_input(grant.token),
            1_000 + MIN_APPROVAL_TOKEN_TTL_MS,
        );

        assert!(!rejected.valid);
        assert!(rejected
            .reason
            .as_deref()
            .unwrap_or_default()
            .contains("invalid or expired"));
        assert_eq!(store.active_count(1_000 + MIN_APPROVAL_TOKEN_TTL_MS), 0);
    }

    #[test]
    fn revokes_active_token() {
        let mut store = ExternalAgentApprovalTokenStore::default();
        let grant = store.issue(plan_apply_input(), 1_000).expect("grant");

        assert!(store.revoke(&grant.token, 2_000));
        assert!(!store.consume(consume_input(grant.token), 2_001).valid);
    }
}
