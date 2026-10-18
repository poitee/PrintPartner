/// Startup opt-in for the desktop rebuild. Both build and runtime gates must be on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DesktopRebuild(bool);

impl DesktopRebuild {
    pub fn from_env() -> Self {
        Self::from_value(std::env::var("PP_DESKTOP_REBUILD").ok().as_deref())
    }

    pub fn enabled(self) -> bool {
        self.0
    }

    pub(crate) fn from_value(value: Option<&str>) -> Self {
        Self(cfg!(feature = "desktop_rebuild") && matches!(value, Some("1" | "true")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_and_unrecognized_values_are_off() {
        assert!(!DesktopRebuild::default().enabled());
        for value in [
            None,
            Some(""),
            Some("0"),
            Some("false"),
            Some("TRUE"),
            Some(" true "),
            Some("yes"),
        ] {
            assert!(!DesktopRebuild::from_value(value).enabled(), "{value:?}");
        }
    }

    #[test]
    fn runtime_opt_in_requires_the_cargo_feature() {
        for value in ["1", "true"] {
            assert_eq!(
                DesktopRebuild::from_value(Some(value)).enabled(),
                cfg!(feature = "desktop_rebuild")
            );
        }
    }

    #[test]
    fn environment_read_is_isolated_from_the_test_process() {
        for value in [
            None,
            Some("0"),
            Some("false"),
            Some("true"),
            Some("1"),
            Some("invalid"),
        ] {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command.args([
                "--ignored",
                "--exact",
                "rebuild::tests::read_environment_in_child",
            ]);
            command.env_remove("PP_DESKTOP_REBUILD");
            if let Some(value) = value {
                command.env("PP_DESKTOP_REBUILD", value);
            }
            let expected = cfg!(feature = "desktop_rebuild") && matches!(value, Some("1" | "true"));
            command.env("PP_REBUILD_TEST_EXPECTED", expected.to_string());
            let output = command.output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stdout)
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
        }
    }

    #[test]
    #[ignore = "runs in an isolated subprocess with explicit environment"]
    fn read_environment_in_child() {
        let expected = std::env::var("PP_REBUILD_TEST_EXPECTED").unwrap() == "true";
        assert_eq!(DesktopRebuild::from_env().enabled(), expected);
    }
}
