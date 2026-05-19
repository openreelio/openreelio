//! License policy decisions for asset discovery and import preflight.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use specta::Type;

use super::{LicenseInfo, LicenseSource, LicenseType};

/// Runtime context used when evaluating whether an asset license fits a workflow.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LicensePolicyContext {
    /// Whether the intended use can be commercial.
    pub commercial_use: bool,
    /// Whether the user/project can satisfy attribution requirements.
    pub attribution_ok: bool,
    /// Whether editorial-only assets should be rejected.
    pub exclude_editorial: bool,
}

impl Default for LicensePolicyContext {
    fn default() -> Self {
        Self {
            commercial_use: true,
            attribution_ok: true,
            exclude_editorial: true,
        }
    }
}

/// Result category for a license policy check.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum LicensePolicyStatus {
    Allowed,
    Warning,
    Blocked,
}

/// Follow-up action a caller must enforce before import, placement, or export.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum LicensePolicyRequiredAction {
    LicenseSnapshotRequired,
    AttributionRequired,
    ManualReviewRequired,
    ProviderTermsRequired,
}

/// Enforceable policy decision for a candidate asset license.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LicensePolicyDecision {
    pub status: LicensePolicyStatus,
    pub required_actions: Vec<LicensePolicyRequiredAction>,
    pub reasons: Vec<String>,
}

impl LicensePolicyDecision {
    pub fn is_blocked(&self) -> bool {
        self.status == LicensePolicyStatus::Blocked
    }
}

fn has_allowed_use(license: &LicenseInfo, value: &str) -> bool {
    license
        .allowed_use
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(value))
}

fn add_action_once(
    actions: &mut Vec<LicensePolicyRequiredAction>,
    action: LicensePolicyRequiredAction,
) {
    if !actions.contains(&action) {
        actions.push(action);
    }
}

fn mark_warning(status: &mut LicensePolicyStatus) {
    if *status == LicensePolicyStatus::Allowed {
        *status = LicensePolicyStatus::Warning;
    }
}

/// Evaluates a license for the current asset discovery/import policy.
pub fn evaluate_license_policy(
    license: &LicenseInfo,
    context: &LicensePolicyContext,
) -> LicensePolicyDecision {
    let mut status = LicensePolicyStatus::Allowed;
    let mut required_actions = Vec::new();
    let mut reasons = Vec::new();

    if matches!(
        license.source,
        LicenseSource::StockProvider | LicenseSource::Plugin | LicenseSource::Generated
    ) {
        add_action_once(
            &mut required_actions,
            LicensePolicyRequiredAction::LicenseSnapshotRequired,
        );
        add_action_once(
            &mut required_actions,
            LicensePolicyRequiredAction::ProviderTermsRequired,
        );
    }

    if context.commercial_use && !has_allowed_use(license, "commercial") {
        status = LicensePolicyStatus::Blocked;
        reasons.push("License does not grant commercial use.".to_string());
    }

    match license.license_type {
        LicenseType::CcBy => {
            add_action_once(
                &mut required_actions,
                LicensePolicyRequiredAction::AttributionRequired,
            );
            if !context.attribution_ok {
                status = LicensePolicyStatus::Blocked;
                reasons.push(
                    "License requires attribution, but attribution is not allowed.".to_string(),
                );
            }
        }
        LicenseType::CcBySa => {
            add_action_once(
                &mut required_actions,
                LicensePolicyRequiredAction::AttributionRequired,
            );
            add_action_once(
                &mut required_actions,
                LicensePolicyRequiredAction::ManualReviewRequired,
            );
            mark_warning(&mut status);
            reasons.push(
                "Share-alike license may impose downstream distribution requirements.".to_string(),
            );
            if !context.attribution_ok {
                status = LicensePolicyStatus::Blocked;
                reasons.push(
                    "License requires attribution, but attribution is not allowed.".to_string(),
                );
            }
        }
        LicenseType::Editorial => {
            add_action_once(
                &mut required_actions,
                LicensePolicyRequiredAction::ManualReviewRequired,
            );
            if context.exclude_editorial {
                status = LicensePolicyStatus::Blocked;
                reasons.push("Editorial-only assets are excluded by policy.".to_string());
            } else {
                mark_warning(&mut status);
                reasons.push("Editorial license requires manual usage review.".to_string());
            }
        }
        LicenseType::Custom | LicenseType::Unknown => {
            add_action_once(
                &mut required_actions,
                LicensePolicyRequiredAction::ManualReviewRequired,
            );
            mark_warning(&mut status);
            reasons.push("License terms require manual review before final use.".to_string());
        }
        LicenseType::RoyaltyFree | LicenseType::Cc0 => {}
    }

    if let Some(expires_at) = &license.expires_at {
        match chrono::DateTime::parse_from_rfc3339(expires_at) {
            Ok(expiration) if expiration.with_timezone(&Utc) < Utc::now() => {
                status = LicensePolicyStatus::Blocked;
                reasons.push("License has expired.".to_string());
            }
            Ok(_) => {}
            Err(_) => {
                add_action_once(
                    &mut required_actions,
                    LicensePolicyRequiredAction::ManualReviewRequired,
                );
                mark_warning(&mut status);
                reasons.push("License expiration date could not be parsed.".to_string());
            }
        }
    }

    if reasons.is_empty() {
        reasons.push("License is allowed under the current policy context.".to_string());
    }

    LicensePolicyDecision {
        status,
        required_actions,
        reasons,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stock_license(license_type: LicenseType, allowed_use: Vec<&str>) -> LicenseInfo {
        LicenseInfo {
            source: LicenseSource::StockProvider,
            provider: Some("Test".to_string()),
            license_type,
            proof_path: None,
            allowed_use: allowed_use.into_iter().map(str::to_string).collect(),
            expires_at: None,
        }
    }

    #[test]
    fn royalty_free_commercial_stock_requires_snapshot_but_is_allowed() {
        let decision = evaluate_license_policy(
            &stock_license(LicenseType::RoyaltyFree, vec!["personal", "commercial"]),
            &LicensePolicyContext::default(),
        );

        assert_eq!(decision.status, LicensePolicyStatus::Allowed);
        assert!(decision
            .required_actions
            .contains(&LicensePolicyRequiredAction::LicenseSnapshotRequired));
        assert!(decision
            .required_actions
            .contains(&LicensePolicyRequiredAction::ProviderTermsRequired));
    }

    #[test]
    fn missing_commercial_grant_blocks_commercial_policy() {
        let decision = evaluate_license_policy(
            &stock_license(LicenseType::RoyaltyFree, vec!["personal"]),
            &LicensePolicyContext::default(),
        );

        assert_eq!(decision.status, LicensePolicyStatus::Blocked);
        assert!(decision
            .reasons
            .iter()
            .any(|reason| reason.contains("commercial use")));
    }

    #[test]
    fn cc_by_requires_attribution_and_can_be_blocked() {
        let decision = evaluate_license_policy(
            &stock_license(LicenseType::CcBy, vec!["personal", "commercial"]),
            &LicensePolicyContext {
                attribution_ok: false,
                ..Default::default()
            },
        );

        assert_eq!(decision.status, LicensePolicyStatus::Blocked);
        assert!(decision
            .required_actions
            .contains(&LicensePolicyRequiredAction::AttributionRequired));
    }

    #[test]
    fn unknown_license_warns_for_manual_review() {
        let decision = evaluate_license_policy(
            &stock_license(LicenseType::Unknown, vec!["personal", "commercial"]),
            &LicensePolicyContext::default(),
        );

        assert_eq!(decision.status, LicensePolicyStatus::Warning);
        assert!(decision
            .required_actions
            .contains(&LicensePolicyRequiredAction::ManualReviewRequired));
    }
}
