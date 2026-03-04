//! Input validation for CLI parameters.
//!
//! Validates user inputs at the CLI boundary before passing to the core engine.
//! This catches malformed inputs early with clear, actionable error messages.

/// Validates that a time value in seconds is non-negative.
pub fn time_non_negative(value: f64, param_name: &str) -> anyhow::Result<()> {
    if value.is_nan() || value.is_infinite() {
        return Err(anyhow::anyhow!(
            "Invalid value for --{}: must be a finite number",
            param_name
        ));
    }
    if value < 0.0 {
        return Err(anyhow::anyhow!(
            "Invalid value for --{}: time cannot be negative (got {})",
            param_name,
            value
        ));
    }
    Ok(())
}

/// Validates that a speed multiplier is positive and finite.
pub fn speed_positive(value: f32) -> anyhow::Result<()> {
    if value.is_nan() || value.is_infinite() {
        return Err(anyhow::anyhow!(
            "Invalid value for --speed: must be a finite number"
        ));
    }
    if value <= 0.0 {
        return Err(anyhow::anyhow!(
            "Invalid value for --speed: must be positive (got {})",
            value
        ));
    }
    Ok(())
}

/// Validates that a string parameter is not empty.
pub fn non_empty(value: &str, param_name: &str) -> anyhow::Result<()> {
    if value.trim().is_empty() {
        return Err(anyhow::anyhow!(
            "Invalid value for --{}: cannot be empty",
            param_name
        ));
    }
    Ok(())
}

/// Validates that start < end for a time range.
pub fn time_range_ordered(start: f64, end: f64, start_name: &str, end_name: &str) -> anyhow::Result<()> {
    time_non_negative(start, start_name)?;
    time_non_negative(end, end_name)?;
    if start >= end {
        return Err(anyhow::anyhow!(
            "Invalid time range: --{} ({}) must be less than --{} ({})",
            start_name,
            start,
            end_name,
            end
        ));
    }
    Ok(())
}

/// Validates trim in/out points: if both are provided, in must be less than out.
pub fn trim_points_ordered(source_in: Option<f64>, source_out: Option<f64>) -> anyhow::Result<()> {
    if let Some(in_val) = source_in {
        time_non_negative(in_val, "in")?;
    }
    if let Some(out_val) = source_out {
        time_non_negative(out_val, "out")?;
    }
    if let (Some(in_val), Some(out_val)) = (source_in, source_out) {
        if in_val >= out_val {
            return Err(anyhow::anyhow!(
                "Invalid trim range: --in ({}) must be less than --out ({})",
                in_val,
                out_val
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_time_non_negative_accepts_zero() {
        assert!(time_non_negative(0.0, "at").is_ok());
    }

    #[test]
    fn test_time_non_negative_accepts_positive() {
        assert!(time_non_negative(5.5, "at").is_ok());
    }

    #[test]
    fn test_time_non_negative_rejects_negative() {
        assert!(time_non_negative(-1.0, "at").is_err());
    }

    #[test]
    fn test_time_non_negative_rejects_nan() {
        assert!(time_non_negative(f64::NAN, "at").is_err());
    }

    #[test]
    fn test_time_non_negative_rejects_infinity() {
        assert!(time_non_negative(f64::INFINITY, "at").is_err());
    }

    #[test]
    fn test_speed_positive_accepts_normal() {
        assert!(speed_positive(2.0).is_ok());
        assert!(speed_positive(0.5).is_ok());
    }

    #[test]
    fn test_speed_positive_rejects_zero() {
        assert!(speed_positive(0.0).is_err());
    }

    #[test]
    fn test_speed_positive_rejects_negative() {
        assert!(speed_positive(-1.0).is_err());
    }

    #[test]
    fn test_non_empty_accepts_normal() {
        assert!(non_empty("hello", "name").is_ok());
    }

    #[test]
    fn test_non_empty_rejects_empty() {
        assert!(non_empty("", "name").is_err());
    }

    #[test]
    fn test_non_empty_rejects_whitespace() {
        assert!(non_empty("  ", "name").is_err());
    }

    #[test]
    fn test_time_range_ordered_accepts_valid() {
        assert!(time_range_ordered(0.0, 5.0, "start", "end").is_ok());
    }

    #[test]
    fn test_time_range_ordered_rejects_equal() {
        assert!(time_range_ordered(5.0, 5.0, "start", "end").is_err());
    }

    #[test]
    fn test_time_range_ordered_rejects_inverted() {
        assert!(time_range_ordered(10.0, 5.0, "start", "end").is_err());
    }

    #[test]
    fn test_trim_points_ordered_accepts_partial() {
        assert!(trim_points_ordered(Some(2.0), None).is_ok());
        assert!(trim_points_ordered(None, Some(5.0)).is_ok());
        assert!(trim_points_ordered(None, None).is_ok());
    }

    #[test]
    fn test_trim_points_ordered_rejects_inverted() {
        assert!(trim_points_ordered(Some(8.0), Some(5.0)).is_err());
    }
}
