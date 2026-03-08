//! Dynamic Time Warping (DTW) Algorithm (ADR-050)
//!
//! Pure-function implementation of standard DTW for aligning two
//! duration sequences. Used by the style planner to map reference
//! shot pacing onto source footage.
//!
//! Complexity: O(n * m) time and space, where n and m are the
//! lengths of the input sequences.

use serde::{Deserialize, Serialize};
use specta::Type;

// =============================================================================
// Types
// =============================================================================

/// Result of a DTW alignment between two sequences
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DtwResult {
    /// Aligned index pairs `(reference_idx, source_idx)` from start to end
    pub alignment: Vec<(usize, usize)>,
    /// Total accumulated distance (lower = more similar)
    pub distance: f64,
    /// Full warping path for visualization/debugging (same as alignment)
    pub path: Vec<(usize, usize)>,
}

// =============================================================================
// DTW Algorithm
// =============================================================================

/// Computes the Dynamic Time Warping alignment between two sequences.
///
/// Uses standard DTW with absolute-difference cost on normalized duration
/// sequences so the alignment reflects pacing shape rather than absolute scale.
///
/// # Returns
///
/// A [`DtwResult`] containing the optimal alignment path and total
/// accumulated distance. For identical sequences the distance is 0.0.
///
/// # Edge cases
///
/// - Empty input(s): returns distance 0.0 with an empty path.
/// - Single-element inputs: returns trivial 1-pair alignment.
pub fn dtw_align(reference: &[f64], source: &[f64]) -> DtwResult {
    let n = reference.len();
    let m = source.len();

    if n == 0 || m == 0 {
        return DtwResult {
            alignment: Vec::new(),
            distance: 0.0,
            path: Vec::new(),
        };
    }

    let normalized_reference = normalize_sequence(reference);
    let normalized_source = normalize_sequence(source);

    // Build the DP cost matrix
    let mut dp = vec![vec![f64::MAX; m]; n];

    dp[0][0] = (normalized_reference[0] - normalized_source[0]).abs();

    // Fill first column
    for i in 1..n {
        dp[i][0] = dp[i - 1][0] + (normalized_reference[i] - normalized_source[0]).abs();
    }

    // Fill first row
    for (j, src_val) in normalized_source.iter().enumerate().skip(1) {
        dp[0][j] = dp[0][j - 1] + (normalized_reference[0] - src_val).abs();
    }

    // Fill rest of the matrix
    for i in 1..n {
        for (j, src_val) in normalized_source.iter().enumerate().skip(1) {
            let cost = (normalized_reference[i] - src_val).abs();
            dp[i][j] = cost + dp[i - 1][j - 1].min(dp[i - 1][j]).min(dp[i][j - 1]);
        }
    }

    let distance = dp[n - 1][m - 1];

    // Backtrack to find optimal path
    let path = backtrack(&dp, n, m);

    DtwResult {
        alignment: path.clone(),
        distance,
        path,
    }
}

/// Normalizes a duration sequence into relative proportions.
fn normalize_sequence(sequence: &[f64]) -> Vec<f64> {
    let total = sequence
        .iter()
        .copied()
        .filter(|value| *value > 0.0)
        .sum::<f64>();
    if total <= f64::EPSILON {
        return vec![0.0; sequence.len()];
    }

    sequence
        .iter()
        .map(|value| if *value > 0.0 { *value / total } else { 0.0 })
        .collect()
}

/// Backtracks through the DP matrix to recover the optimal warping path.
fn backtrack(dp: &[Vec<f64>], n: usize, m: usize) -> Vec<(usize, usize)> {
    let mut path = Vec::with_capacity(n + m);
    let mut i = n - 1;
    let mut j = m - 1;

    path.push((i, j));

    while i > 0 || j > 0 {
        if i == 0 {
            j -= 1;
        } else if j == 0 {
            i -= 1;
        } else {
            let diag = dp[i - 1][j - 1];
            let up = dp[i - 1][j];
            let left = dp[i][j - 1];

            if diag <= up && diag <= left {
                i -= 1;
                j -= 1;
            } else if up <= left {
                i -= 1;
            } else {
                j -= 1;
            }
        }
        path.push((i, j));
    }

    path.reverse();
    path
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_return_zero_distance_for_identical_sequences() {
        let seq = vec![2.0, 3.0, 1.0, 4.0];
        let result = dtw_align(&seq, &seq);

        assert!(
            result.distance.abs() < 1e-10,
            "Expected 0.0, got {}",
            result.distance
        );
        // 1:1 alignment
        assert_eq!(result.alignment.len(), seq.len());
        for (i, &(ri, si)) in result.alignment.iter().enumerate() {
            assert_eq!(ri, i);
            assert_eq!(si, i);
        }
    }

    #[test]
    fn should_align_different_length_sequences() {
        let reference = vec![1.0, 2.0, 3.0];
        let source = vec![1.0, 1.5, 2.0, 2.5, 3.0];
        let result = dtw_align(&reference, &source);

        // Path should cover all indices of both sequences
        assert!(!result.alignment.is_empty());
        assert_eq!(result.alignment.first(), Some(&(0, 0)));
        assert_eq!(result.alignment.last(), Some(&(2, 4)));

        // Every index should appear at least once
        let ref_indices: Vec<usize> = result.alignment.iter().map(|&(r, _)| r).collect();
        let src_indices: Vec<usize> = result.alignment.iter().map(|&(_, s)| s).collect();
        for i in 0..3 {
            assert!(ref_indices.contains(&i), "Missing ref index {}", i);
        }
        for j in 0..5 {
            assert!(src_indices.contains(&j), "Missing src index {}", j);
        }
    }

    #[test]
    fn should_handle_single_element_sequences() {
        let result = dtw_align(&[5.0], &[3.0]);

        assert!(result.distance.abs() < 1e-10);
        assert_eq!(result.alignment, vec![(0, 0)]);
    }

    #[test]
    fn should_handle_single_vs_multiple_elements() {
        let result = dtw_align(&[5.0], &[3.0, 4.0, 5.0]);

        // Path must start at (0,0) and end at (0,2)
        assert_eq!(result.alignment.first(), Some(&(0, 0)));
        assert_eq!(result.alignment.last(), Some(&(0, 2)));
        assert!(result.distance >= 0.0);
    }

    #[test]
    fn should_return_zero_distance_for_proportionally_identical_sequences() {
        let reference = vec![2.0, 3.0, 5.0];
        let source = vec![4.0, 6.0, 10.0];

        let result = dtw_align(&reference, &source);

        assert!(result.distance.abs() < 1e-10);
        assert_eq!(result.alignment, vec![(0, 0), (1, 1), (2, 2)]);
    }

    #[test]
    fn should_return_empty_result_for_empty_sequences() {
        let result = dtw_align(&[], &[1.0, 2.0]);
        assert!(result.alignment.is_empty());
        assert_eq!(result.distance, 0.0);

        let result = dtw_align(&[1.0], &[]);
        assert!(result.alignment.is_empty());
        assert_eq!(result.distance, 0.0);

        let result = dtw_align(&[], &[]);
        assert!(result.alignment.is_empty());
        assert_eq!(result.distance, 0.0);
    }

    #[test]
    fn should_prefer_diagonal_path_for_similar_sequences() {
        let reference = vec![1.0, 2.0, 3.0, 4.0];
        let source = vec![1.1, 2.1, 3.1, 4.1];
        let result = dtw_align(&reference, &source);

        // Should get perfect diagonal alignment
        assert_eq!(result.alignment.len(), 4);
        for (i, &(ri, si)) in result.alignment.iter().enumerate() {
            assert_eq!(ri, i);
            assert_eq!(si, i);
        }
        assert!(result.distance < 0.1);
    }

    #[test]
    fn should_handle_time_shifted_sequences() {
        let reference = vec![1.0, 2.0, 3.0, 4.0, 5.0];
        let source = vec![3.0, 4.0, 5.0, 6.0, 7.0]; // shifted by +2
        let result = dtw_align(&reference, &source);

        // Should still find a valid alignment
        assert!(!result.alignment.is_empty());
        assert_eq!(result.alignment.first(), Some(&(0, 0)));
        assert_eq!(result.alignment.last(), Some(&(4, 4)));
    }

    #[test]
    fn should_complete_large_sequences_quickly() {
        let n = 100;
        let reference: Vec<f64> = (0..n).map(|i| (i as f64) * 0.5).collect();
        let source: Vec<f64> = (0..n).map(|i| (i as f64) * 0.5 + 0.1).collect();

        let start = std::time::Instant::now();
        let result = dtw_align(&reference, &source);
        let elapsed = start.elapsed();

        assert!(!result.alignment.is_empty());
        assert!(
            elapsed.as_millis() < 100,
            "DTW took {}ms for 100x100, expected <100ms",
            elapsed.as_millis()
        );
    }

    #[test]
    fn should_produce_monotonic_path() {
        let reference = vec![2.0, 5.0, 1.0, 8.0, 3.0];
        let source = vec![3.0, 6.0, 2.0, 7.0];
        let result = dtw_align(&reference, &source);

        // Path indices should be non-decreasing
        for window in result.path.windows(2) {
            assert!(
                window[1].0 >= window[0].0 && window[1].1 >= window[0].1,
                "Non-monotonic: {:?} -> {:?}",
                window[0],
                window[1]
            );
        }
    }

    #[test]
    fn should_roundtrip_dtw_result_via_json() {
        let result = DtwResult {
            alignment: vec![(0, 0), (1, 1), (2, 2)],
            distance: 0.5,
            path: vec![(0, 0), (1, 1), (2, 2)],
        };

        let json = serde_json::to_string(&result).unwrap();
        let parsed: DtwResult = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.alignment, result.alignment);
        assert!((parsed.distance - 0.5).abs() < 1e-10);
    }
}
