import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { TopBar } from "../App.jsx";
import { createInterview } from "../api/interviews.js";
import { listResumes, uploadResume } from "../api/resumes.js";
import { getRoles } from "../api/roles.js";
import { ErrorBox, StatusLine } from "../components/StateViews.jsx";
import { DIFFICULTY_LABELS, INTERVIEW_TYPE_LABELS, PERSONA_LABELS, formatDateTime } from "../lib/format.js";

/** The wizard is exactly five steps: Resume -> Role -> Type -> Settings -> Review. */
const STEPS = [
  { number: 1, label: "Resume", title: "Choose a Resume", hint: "Attach a stored resume or upload a new one. This step is optional." },
  { number: 2, label: "Role", title: "Select Role", hint: "Pick the role you are preparing for, or type your own." },
  { number: 3, label: "Interview Type", title: "Choose Interview Type", hint: "Select the focus for your practice session." },
  { number: 4, label: "Settings", title: "Interview Settings", hint: "Fine-tune the session to match your preferences." },
  { number: 5, label: "Review", title: "Review Your Interview", hint: "Check every detail, then start when you are ready." },
];

const QUESTION_COUNTS = [5, 10, 15, 20].map((n) => ({ value: n, label: String(n) }));

// Client-side mirrors of the backend contract (backend stays authoritative).
const ALLOWED_EXTENSIONS = [".pdf", ".doc", ".docx"];
const MAX_CLIENT_SIZE_BYTES = 10 * 1024 * 1024;
const MIN_ROLE_CHARS = 2;
const MAX_ROLE_CHARS = 255;
const MAX_LANGUAGE_CHARS = 128;

const TYPE_DESCRIPTIONS = {
  TECHNICAL: "Coding, system design and technical depth",
  BEHAVIORAL: "Communication, teamwork and situational judgement",
  MIXED: "A balanced technical and behavioural session",
};

// Shortcuts on top of the backend /roles list. Any role typed by the user is
// sent through the same create-interview flow, so this list never restricts
// what the interview service can be asked for.
const COMMON_ROLE_SUGGESTIONS = [
  "Software Engineer", "Backend Developer", "Frontend Developer", "Full Stack Developer",
  "Mobile Developer", "Data Analyst", "Data Scientist", "Data Engineer", "ML Engineer",
  "AI Engineer", "DevOps Engineer", "Cloud Engineer", "Site Reliability Engineer",
  "Platform Engineer", "Cybersecurity Engineer", "Network Engineer", "Database Engineer",
  "QA / Test Engineer", "Automation Test Engineer", "Embedded Systems Engineer",
  "Solutions Architect", "Technical Support Engineer", "Product Manager", "Project Manager",
  "Scrum Master", "Business Analyst", "UI / UX Designer", "Operations Manager",
  "Marketing Manager", "Sales Executive", "Customer Success Manager", "HR Specialist",
  "Finance Analyst", "Content Writer", "Mechanical Engineer", "Electrical Engineer", "Civil Engineer",
];

const COMMON_LANGUAGE_SUGGESTIONS = ["Python", "JavaScript", "TypeScript", "Java", "C#", "C++", "Go", "Rust", "Kotlin", "Swift", "SQL", "PHP", "Ruby", "Scala", "R", "Dart", "Bash"];

const EMPTY_ROLES = [];

/** Local pre-flight check; the backend rejects unsupported files as well. */
function validateResumeFile(file) {
  const lower = (file?.name || "").toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return "Unsupported file type. Please upload a PDF, DOC or DOCX file.";
  }
  if (file.size > MAX_CLIENT_SIZE_BYTES) {
    return "File is too large (10 MB limit).";
  }
  return null;
}
function resumeStatusChip(resume) {
  const status = String(resume?.status || "").toUpperCase();
  if (status === "FAILED") return { label: "Failed", tone: "failed" };
  if (status === "PROCESSING") return { label: "Processing", tone: "processing" };
  if (status === "READY" || status === "PROCESSED" || resume?.parsed_at) return { label: "Ready", tone: "ready" };
  return { label: "Uploaded", tone: "uploaded" };
}


export default function SetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const panelRef = useRef(null);
  const fileInputRef = useRef(null);

  const rolesQuery = useQuery({ queryKey: ["roles"], queryFn: getRoles });
  const resumesQuery = useQuery({ queryKey: ["resumes", 1], queryFn: () => listResumes(1, 50) });

  const backendRoles = rolesQuery.data?.items ?? EMPTY_ROLES;
  const roles = useMemo(() => {
    const byName = new Map(backendRoles.map((item) => [item.role, item]));
    COMMON_ROLE_SUGGESTIONS.forEach((roleName) => {
      if (!byName.has(roleName)) byName.set(roleName, { role: roleName, interview_types: ["TECHNICAL", "BEHAVIORAL", "MIXED"], difficulties: ["EASY", "MEDIUM", "HARD"], languages: [] });
    });
    return [...byName.values()];
  }, [backendRoles]);
  const [step, setStep] = useState(1);
  const [resumeId, setResumeId] = useState("");
  const [role, setRole] = useState("");
  const [customRole, setCustomRole] = useState("");
  const [roleSearch, setRoleSearch] = useState("");
  const [interviewType, setInterviewType] = useState("MIXED");
  const [difficulty, setDifficulty] = useState("MEDIUM");
  const [persona, setPersona] = useState("PROFESSIONAL");
  const [language, setLanguage] = useState("");
  const [languageSearch, setLanguageSearch] = useState("");
  const [questionCount, setQuestionCount] = useState(10);
  const [clientError, setClientError] = useState(null);
  const [attemptedNext, setAttemptedNext] = useState(false);

  const selectedRole = useMemo(
    () => roles.find((item) => item.role === role) || (role ? { role, interview_types: ["TECHNICAL", "BEHAVIORAL", "MIXED"], difficulties: ["EASY", "MEDIUM", "HARD"], languages: [] } : null),
    [roles, role],
  );

  // Role capabilities come from the backend: only advertised values shown.
  const typeOptions = useMemo(() => {
    const allowed = selectedRole?.interview_types ?? ["TECHNICAL", "BEHAVIORAL", "MIXED"];
    return allowed.map((type) => ({ value: type, label: INTERVIEW_TYPE_LABELS[type] || type }));
  }, [selectedRole]);

  const difficultyOptions = useMemo(() => {
    const allowed = selectedRole?.difficulties ?? ["EASY", "MEDIUM", "HARD", "EXPERT"];
    return allowed.map((level) => ({ value: level, label: DIFFICULTY_LABELS[level] || level }));
  }, [selectedRole]);

  const languageOptions = useMemo(() => [...new Set([...(selectedRole?.languages ?? []), ...COMMON_LANGUAGE_SUGGESTIONS])], [selectedRole]);

  // Capability-safe selections: a role may advertise a narrower set than the
  // current selection, so the effective values are derived (never force-synced
  // through an effect) and these are what the review + payload use.
  const effectiveInterviewType = typeOptions.some((option) => option.value === interviewType)
    ? interviewType
    : typeOptions[0]?.value ?? interviewType;
  const effectiveDifficulty = difficultyOptions.some((option) => option.value === difficulty)
    ? difficulty
    : difficultyOptions[0]?.value ?? difficulty;

  const resumes = resumesQuery.data?.items ?? [];
  const filteredRoles = roles.filter((item) => item.role.toLowerCase().includes(roleSearch.trim().toLowerCase()));
  const filteredLanguages = languageOptions.filter((item) => item.toLowerCase().includes(languageSearch.trim().toLowerCase()));
  const selectedResume = resumes.find((item) => item.id === resumeId) || null;
  const trimmedRole = role.trim();
  const trimmedLanguage = language.trim();
  const roleError = trimmedRole.length === 0
    ? "Select a role or enter your own to continue."
    : trimmedRole.length < MIN_ROLE_CHARS ? `Enter at least ${MIN_ROLE_CHARS} characters for the role.` : null;
  const currentStep = STEPS[step - 1];

  // Move focus into the panel on every step change so keyboard users follow.
  useEffect(() => {
    panelRef.current?.focus();
  }, [step]);

  const resumeUpload = useMutation({
    mutationFn: (file) => uploadResume(file),
    onSuccess: (uploaded) => {
      setClientError(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (uploaded?.id) setResumeId(String(uploaded.id));
      queryClient.invalidateQueries({ queryKey: ["resumes"] });
    },
  });

  const createMutation = useMutation({
    mutationFn: (payload) => createInterview(payload),
    onSuccess: (interview) => {
      queryClient.invalidateQueries({ queryKey: ["interviews"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-history"] });
      navigate(`/lobby/${interview.id}`);
    },
  });

  function onChooseResumeFile(event) {
    setClientError(null);
    const file = event.target.files?.[0];
    if (!file) return;
    const problem = validateResumeFile(file);
    if (problem) {
      setClientError({ code: "INVALID_FILE", message: problem });
      event.target.value = "";
      return;
    }
    resumeUpload.mutate(file);
  }

  function chooseRole(nextRole) {
    setRole(nextRole);
    setCustomRole("");
    setLanguage("");
    setLanguageSearch("");
    setAttemptedNext(false);
  }

  function onCustomRoleChange(value) {
    setCustomRole(value);
    setRole(value);
    setLanguage("");
    setLanguageSearch("");
  }

  function onCreate() {
    if (roleError) {
      setAttemptedNext(true);
      setStep(2);
      return;
    }
    // Payload shape is unchanged from the original implementation: the same
    // POST /interviews contract carries custom roles and languages.
    createMutation.mutate({
      resume_id: resumeId || null,
      target_role: trimmedRole,
      programming_language: trimmedLanguage || null,
      interview_type: effectiveInterviewType,
      difficulty: effectiveDifficulty,
      interviewer_persona: persona,
      question_count: questionCount,
    });
  }

  function canContinue() {
    if (step === 1) return true; // resume attachment is optional
    if (step === 2) return !roleError;
    if (step === 3) return Boolean(effectiveInterviewType);
    if (step === 4) return Boolean(effectiveDifficulty && persona && questionCount);
    return !roleError;
  }

  function nextStep() {
    if (!canContinue()) {
      setAttemptedNext(true);
      return;
    }
    setAttemptedNext(false);
    setStep((current) => Math.min(STEPS.length, current + 1));
  }

  function goBack() {
    setAttemptedNext(false);
    setStep((current) => Math.max(1, current - 1));
  }


  // Review rows carry the step they came from, so each row can jump back.
  const reviewItems = [
    { label: "Resume", value: selectedResume?.filename || "No resume attached", stepToEdit: 1 },
    { label: "Target Role", value: trimmedRole || "Not selected", stepToEdit: 2 },
    { label: "Interview Type", value: INTERVIEW_TYPE_LABELS[effectiveInterviewType] || effectiveInterviewType, stepToEdit: 3 },
    { label: "Difficulty", value: DIFFICULTY_LABELS[effectiveDifficulty] || effectiveDifficulty, stepToEdit: 4 },
    { label: "Interviewer Persona", value: PERSONA_LABELS[persona] || persona, stepToEdit: 4 },
    { label: "Programming Language", value: trimmedLanguage || "No preference", stepToEdit: 4 },
    { label: "Questions", value: `${questionCount} questions`, stepToEdit: 4 },
  ];

  return (
    <div className="app-page setup-page">
      <TopBar title="Interview Setup" />

      <main className="setup-container">
        <div className="setup-heading">
          <div><h1 className="visually-hidden">Interview Setup</h1><span className="dashboard-eyebrow">INTERVIEW WORKSPACE</span><h2>Set up your interview</h2><p>Five short steps to a personalised practice session.</p></div>
          <span className="setup-step-count" aria-live="polite">Step {step} of {STEPS.length} · {currentStep.label}</span>
        </div>

        <ErrorBox error={rolesQuery.error} onRetry={() => rolesQuery.refetch()} />
        <ErrorBox error={resumesQuery.error} onRetry={() => resumesQuery.refetch()} />
        <ErrorBox error={createMutation.error} onRetry={() => createMutation.reset()} />

        <div className="setup-stepper" role="group" aria-label="Interview setup steps">
          {STEPS.map(({ number, label }) => {
            const complete = step > number;
            const current = step === number;
            return (
              <button
                key={label}
                type="button"
                className={`${current ? "current" : ""} ${complete ? "complete" : ""}`}
                aria-current={current ? "step" : undefined}
                aria-disabled={complete || current ? undefined : true}
                title={complete ? `Back to ${label}` : current ? `${label} (current step)` : `${label} — complete the earlier steps first`}
                onClick={() => { if (complete) setStep(number); }}
              >
                <span aria-hidden="true">{complete ? "✓" : number}</span>
                <strong>{label}</strong>
              </button>
            );
          })}
        </div>

        <section className="setup-panel" ref={panelRef} tabIndex={-1} aria-label={`Step ${step} of ${STEPS.length}: ${currentStep.title}`}>
          <div className="setup-panel-heading">
            <div><h2>{currentStep.title}</h2><p>{currentStep.hint}</p></div>
            <span className="setup-panel-number" aria-hidden="true">{String(step).padStart(2, "0")}</span>
          </div>


          {step === 1 ? (
            <>
              <div className="setup-uploader">
                <div className="setup-uploader-copy">
                  <span className="setup-uploader-icon" aria-hidden="true">↑</span>
                  <span><strong>Upload a new resume</strong><small>PDF, DOC or DOCX · 10 MB maximum</small></span>
                </div>
                <input ref={fileInputRef} id="setup-resume-file" className="visually-hidden" type="file" accept=".pdf,.doc,.docx" aria-label="Upload a resume for this interview" onChange={onChooseResumeFile} />
                <label className="setup-upload-label" htmlFor="setup-resume-file">{resumeUpload.isPending ? "Uploading…" : "Choose File"}</label>
              </div>
              <ErrorBox error={clientError} onRetry={() => setClientError(null)} />
              <ErrorBox error={resumeUpload.error} onRetry={() => resumeUpload.reset()} />

              {resumesQuery.isPending ? <StatusLine>Loading your resumes…</StatusLine> : null}
              {!resumesQuery.isPending && resumes.length === 0 ? <p className="setup-status">No stored resumes yet — upload one above or continue without a resume.</p> : null}

              <div className="setup-resume-grid" role="group" aria-label="Select a resume for this interview">
                <button type="button" aria-pressed={resumeId === ""} className={`setup-resume-card ${resumeId === "" ? "selected" : ""}`} onClick={() => setResumeId("")}>
                  <span className="setup-resume-icon" aria-hidden="true">∅</span>
                  <span><strong>No resume</strong><small>Continue without attaching a resume.</small></span>
                  <i aria-hidden="true">{resumeId === "" ? "✓" : ""}</i>
                </button>
                {resumes.map((resume) => {
                  const chip = resumeStatusChip(resume);
                  return (
                    <button type="button" aria-pressed={resumeId === resume.id} key={resume.id} className={`setup-resume-card ${resumeId === resume.id ? "selected" : ""}`} onClick={() => setResumeId(resume.id)}>
                      <span className="setup-resume-icon" aria-hidden="true">▤</span>
                      <span><strong>{resume.filename}</strong><small>{formatDateTime(resume.created_at)} · <em className={`resume-chip resume-chip-${chip.tone}`}>{chip.label}</em></small></span>
                      <i aria-hidden="true">{resumeId === resume.id ? "✓" : ""}</i>
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <label className="setup-search">
                <span aria-hidden="true">⌕</span>
                <input type="search" aria-label="Search roles" placeholder="Search roles…" value={roleSearch} onChange={(event) => setRoleSearch(event.target.value)} />
              </label>
              <div className="role-card-grid">
                {filteredRoles.map((item) => {
                  const active = role === item.role;
                  return (
                    <button type="button" key={item.role} className={`role-card ${active ? "selected" : ""}`} aria-pressed={active} onClick={() => chooseRole(item.role)}>
                      <span className="role-card-icon" aria-hidden="true">{item.role.slice(0, 1)}</span>
                      <span><strong>{item.role}</strong><small>Practice a {item.role} interview.</small></span>
                      <i aria-hidden="true">{active ? "✓" : ""}</i>
                    </button>
                  );
                })}
                {!rolesQuery.isPending && filteredRoles.length === 0 ? <p className="setup-empty">No suggested role matches “{roleSearch.trim()}”. Enter it in the custom role field below.</p> : null}
                <div className={`custom-role-card ${customRole ? "selected" : ""}`}>
                  <div className="custom-role-heading">
                    <span className="role-card-icon" aria-hidden="true">+</span>
                    <span><strong>Custom Role</strong><small>Any role is accepted and passed to the interview service.</small></span>
                  </div>
                  <input aria-label="Custom role" placeholder="e.g. Product Manager" maxLength={MAX_ROLE_CHARS} value={customRole} onChange={(event) => onCustomRoleChange(event.target.value)} />
                  {customRole && roleError ? <span className="field-error" role="alert">{roleError}</span> : null}
                </div>
              </div>
              {rolesQuery.isPending ? <StatusLine>Loading supported roles…</StatusLine> : null}
            </>
          ) : null}


          {step === 3 ? (
            <>
              <div className="setup-choice-grid">{typeOptions.map((option) => (
                <button type="button" key={option.value} className={`setup-choice-card ${effectiveInterviewType === option.value ? "selected" : ""}`} aria-pressed={effectiveInterviewType === option.value} onClick={() => setInterviewType(option.value)}>
                  <span className="choice-radio" aria-hidden="true">{effectiveInterviewType === option.value ? "✓" : ""}</span>
                  <strong>{option.label}</strong>
                  <small>{TYPE_DESCRIPTIONS[option.value] || "Focused practice for this interview type"}</small>
                </button>
              ))}</div>
              <p className="setup-status">Interview types shown here are the ones available for {trimmedRole || "your role"}.</p>
            </>
          ) : null}

          {step === 4 ? (
            <>
              <div className="setup-settings-grid">
                <label>Difficulty
                  <select value={effectiveDifficulty} onChange={(event) => setDifficulty(event.target.value)}>{difficultyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
                </label>
                <label>Interviewer Persona
                  <select value={persona} onChange={(event) => setPersona(event.target.value)}>{Object.entries(PERSONA_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
                </label>
                <label className="setup-settings-wide">Programming Language <span className="setup-field-note">optional</span>
                  <input
                    className="setup-language-input"
                    list="setup-language-options"
                    aria-label="Programming language"
                    placeholder="Type or search, e.g. Python, Rust, Go…"
                    maxLength={MAX_LANGUAGE_CHARS}
                    value={language}
                    onChange={(event) => { setLanguage(event.target.value); setLanguageSearch(event.target.value); }}
                  />
                  <datalist id="setup-language-options">{filteredLanguages.map((item) => <option key={item} value={item} />)}</datalist>
                  <span className="setup-language-suggestions">{[...new Set([...(selectedRole?.languages ?? []), ...COMMON_LANGUAGE_SUGGESTIONS])].slice(0, 10).map((item) => (
                    <button key={item} type="button" className={`setup-chip ${trimmedLanguage === item ? "selected" : ""}`} aria-pressed={trimmedLanguage === item} onClick={() => { const next = trimmedLanguage === item ? "" : item; setLanguage(next); setLanguageSearch(next); }}>{item}</button>
                  ))}</span>
                </label>
                <div className="question-count-section setup-settings-wide">Number of Questions
                  <div>{QUESTION_COUNTS.map((option) => <button type="button" key={option.value} className={questionCount === option.value ? "selected" : ""} aria-pressed={questionCount === option.value} onClick={() => setQuestionCount(option.value)}>{option.label}</button>)}</div>
                </div>
              </div>
            </>
          ) : null}

          {step === 5 ? (
            <>
              <div className="setup-review-grid">
                {reviewItems.map((item) => (
                  <div key={item.label}>
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                    <button type="button" className="setup-review-edit" onClick={() => setStep(item.stepToEdit)}>Edit</button>
                  </div>
                ))}
              </div>
              <p className="setup-status">Starting the interview sends this configuration to the interview service, which generates the questions.</p>
            </>
          ) : null}
        </section>

        {attemptedNext && !canContinue() && roleError ? <p className="setup-validation" id="setup-validation-message" role="alert">{roleError}</p> : null}

        <div className="setup-actions">
          <button className="setup-cancel" type="button" onClick={() => navigate("/")} disabled={createMutation.isPending}>Cancel</button>
          <div>
            {step > 1 ? <button className="setup-back" type="button" onClick={goBack} disabled={createMutation.isPending}>← Back</button> : null}
            {step < STEPS.length ? (
              <button
                className="main-button"
                type="button"
                onClick={nextStep}
                disabled={!canContinue()}
                aria-describedby={attemptedNext && roleError ? "setup-validation-message" : undefined}
              >
                Next →
              </button>
            ) : (
              <button
                className="main-button"
                type="button"
                onClick={onCreate}
                disabled={createMutation.isPending || Boolean(roleError)}
                aria-busy={createMutation.isPending}
              >
                {createMutation.isPending ? "Preparing interview…" : "Start Interview →"}
              </button>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

