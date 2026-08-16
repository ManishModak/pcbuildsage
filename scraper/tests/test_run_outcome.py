from scraper.__main__ import JobOutcome, summarize_run


def test_all_successful_jobs_produce_success():
    outcome = summarize_run([JobOutcome("succeeded", 3), JobOutcome("skipped")])

    assert outcome.status == "succeeded"
    assert outcome.jobs_succeeded == 1
    assert outcome.jobs_skipped == 1
    assert outcome.products_written == 3


def test_mixed_jobs_produce_explicit_partial_failure():
    outcome = summarize_run([
        JobOutcome("succeeded", 3),
        JobOutcome("failed", error="site/category: blocked"),
    ])

    assert outcome.status == "partial"
    assert outcome.jobs_failed == 1
    assert outcome.products_written == 3
    assert outcome.errors == ["site/category: blocked"]


def test_all_failed_jobs_produce_failure():
    outcome = summarize_run([
        JobOutcome("failed", error="first"),
        JobOutcome("failed", error="second"),
    ])

    assert outcome.status == "failed"
    assert outcome.jobs_failed == 2
    assert outcome.errors == ["first", "second"]
