//! Cross-platform process spawning helpers.
//!
//! On Windows, spawning console binaries (ffmpeg, ffprobe, etc.) from a GUI
//! application can cause a console window to appear for each invocation.
//! This module centralizes the Windows creation flags needed to suppress that.

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Apply platform-specific flags to a std process command.
pub fn configure_std_command(cmd: &mut std::process::Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = cmd;
}

/// Apply platform-specific flags to a tokio process command.
pub fn configure_tokio_command(cmd: &mut tokio::process::Command) {
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = cmd;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn std_command_can_be_configured() {
        #[cfg(target_os = "windows")]
        let mut cmd = std::process::Command::new("cmd");
        #[cfg(not(target_os = "windows"))]
        let mut cmd = std::process::Command::new("echo");
        configure_std_command(&mut cmd);
    }

    #[test]
    fn std_command_configuration_is_idempotent() {
        // Calling configure multiple times should not cause issues
        #[cfg(target_os = "windows")]
        let mut cmd = std::process::Command::new("cmd");
        #[cfg(not(target_os = "windows"))]
        let mut cmd = std::process::Command::new("echo");

        configure_std_command(&mut cmd);
        configure_std_command(&mut cmd);
        configure_std_command(&mut cmd);
    }

    #[tokio::test]
    async fn tokio_command_can_be_configured() {
        #[cfg(target_os = "windows")]
        let mut cmd = tokio::process::Command::new("cmd");
        #[cfg(not(target_os = "windows"))]
        let mut cmd = tokio::process::Command::new("echo");
        configure_tokio_command(&mut cmd);
        #[cfg(target_os = "windows")]
        let _ = cmd.args(["/C", "echo", "ok"]).output().await;
        #[cfg(not(target_os = "windows"))]
        let _ = cmd.arg("ok").output().await;
    }

    #[tokio::test]
    async fn tokio_command_configuration_is_idempotent() {
        // Calling configure multiple times should not cause issues
        #[cfg(target_os = "windows")]
        let mut cmd = tokio::process::Command::new("cmd");
        #[cfg(not(target_os = "windows"))]
        let mut cmd = tokio::process::Command::new("echo");

        configure_tokio_command(&mut cmd);
        configure_tokio_command(&mut cmd);
        configure_tokio_command(&mut cmd);
    }

    #[tokio::test]
    async fn tokio_command_can_execute_successfully() {
        #[cfg(target_os = "windows")]
        let mut cmd = tokio::process::Command::new("cmd");
        #[cfg(not(target_os = "windows"))]
        let mut cmd = tokio::process::Command::new("echo");

        configure_tokio_command(&mut cmd);

        #[cfg(target_os = "windows")]
        let output = cmd.args(["/C", "echo", "test"]).output().await;
        #[cfg(not(target_os = "windows"))]
        let output = cmd.arg("test").output().await;

        assert!(output.is_ok(), "Command should execute successfully");
        let output = output.unwrap();
        assert!(output.status.success(), "Command should succeed");
    }

    #[test]
    fn std_command_can_execute_successfully() {
        #[cfg(target_os = "windows")]
        let mut cmd = std::process::Command::new("cmd");
        #[cfg(not(target_os = "windows"))]
        let mut cmd = std::process::Command::new("echo");

        configure_std_command(&mut cmd);

        #[cfg(target_os = "windows")]
        let output = cmd.args(["/C", "echo", "test"]).output();
        #[cfg(not(target_os = "windows"))]
        let output = cmd.arg("test").output();

        assert!(output.is_ok(), "Command should execute successfully");
        let output = output.unwrap();
        assert!(output.status.success(), "Command should succeed");
    }

    #[test]
    fn create_no_window_constant_is_correct() {
        #[cfg(target_os = "windows")]
        {
            // Windows CREATE_NO_WINDOW flag
            assert_eq!(CREATE_NO_WINDOW, 0x08000000);
        }
    }
}
