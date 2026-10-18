#[cfg(feature = "desktop_rebuild")]
macro_rules! claimed_attempt {
    ($job:pat, $lease:pat) => {
        claimed_attempt!($job, $lease, _source_work)
    };
    ($job:pat, $lease:pat, $source:pat) => {
        ClaimedAttempt {
            job: $job,
            lease: $lease,
            source_work: $source,
        }
    };
}
#[cfg(not(feature = "desktop_rebuild"))]
macro_rules! claimed_attempt {
    ($job:pat, $lease:pat $(, $source:pat)?) => {
        ($job, $lease)
    };
}
