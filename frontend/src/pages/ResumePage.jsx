import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TopBar } from "../App.jsx";
import { deleteResume, listResumes, uploadResume } from "../api/resumes.js";
import { EmptyState, ErrorBox, StatusLine } from "../components/StateViews.jsx";
import { formatDateTime } from "../lib/format.js";

const ALLOWED_EXTENSIONS = [".pdf", ".doc", ".docx"];
const MAX_CLIENT_SIZE_BYTES = 10 * 1024 * 1024;
const RESUME_TABLE_HEAD = ["File name", "Uploaded on", "Status", "Actions"];
/**
 * Statuses that still have background work pending. A freshly uploaded resume
 * is persisted as UPLOADED and only later moves to PROCESSING -> READY/FAILED
 * by the Celery worker, so both must keep the client polling; otherwise the
 * list (and the "Ready" chip) stays stale until a manual refresh.
 */
const POLLED_RESUME_STATUSES = new Set(["uploaded", "processing"]);

function validateFile(file) {
  const lower = (file?.name || "").toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return "Unsupported file type. Please upload a PDF, DOC or DOCX file.";
  }
  if (file.size > MAX_CLIENT_SIZE_BYTES) {
    return "File is too large (10 MB limit).";
  }
  return null;
}
function statusDetail(resume) {
  const raw = String(resume?.status || "").toLowerCase();
  if (raw === "ready")
    return { tone: "ready", label: "Ready", title: "Resume processed", description: "Your resume is parsed and ready. Interview questions will be tailored to your background." };
  if (raw === "processing")
    return { tone: "processing", label: "Processing", title: "Processing resume", description: "We are extracting your skills and experience. This usually takes a few seconds." };
  if (raw === "failed")
    return { tone: "failed", label: "Failed", title: "Processing failed", description: "We could not process this resume on the server. Try uploading the file again." };
  if (raw === "uploaded")
    return { tone: "uploaded", label: "Uploaded", title: "Resume received", description: "Your resume was uploaded and is waiting to be processed." };
  return { tone: "none", label: "Not uploaded", title: "No resume yet", description: "Upload your resume to unlock personalised interview preparation." };
}

function ResumeFileIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V5Z" fill="var(--purple)" opacity=".15" />
      <path d="M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V5Z" stroke="var(--purple)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 9h14" stroke="var(--purple)" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M5 13h10" stroke="var(--purple)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function CloudIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M7 18a4.5 4.5 0 0 1-.4-8.98 5.5 5.5 0 0 1 10.7 1.1A3.95 3.95 0 0 1 17 18H7Z" stroke="var(--purple)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 12v5.5M12 12l-2.4 2.4M12 12l2.4 2.4" stroke="var(--purple)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StatusIcon({ tone }) {
  const size = 46;
  const color = tone === "ready" ? "#27a47b"
    : tone === "processing" ? "#3474e7"
    : tone === "failed" ? "#cf5a70"
    : tone === "uploaded" ? "#8054e8"
    : "#a7afbf";
  const track = tone === "ready" ? "#dcf5eb"
    : tone === "processing" ? "#e5efff"
    : tone === "failed" ? "#fae6eb"
    : tone === "uploaded" ? "#eee8ff"
    : "#eef0f4";

  if (tone === "ready")
    return (
      <svg width={size} height={size} viewBox="0 0 44 44" fill="none" aria-hidden="true" focusable="false">
        <circle cx="22" cy="22" r="21" fill={track} />
        <path d="M14 22l5.5 5.5L29 15.5" stroke={color} strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (tone === "processing")
    return (
      <svg width={size} height={size} viewBox="0 0 44 44" fill="none" aria-hidden="true" focusable="false">
        <circle cx="22" cy="22" r="21" fill={track} />
        <path d="M13 22a9 9 0 1 1 18 0" stroke={color} strokeWidth="2.4" strokeLinecap="round" />
        <path d="M20.5 15l4 6.5-4 6.5" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (tone === "failed")
    return (
      <svg width={size} height={size} viewBox="0 0 44 44" fill="none" aria-hidden="true" focusable="false">
        <circle cx="22" cy="22" r="21" fill={track} />
        <path d="M16 14l12 12M28 14l-12 12" stroke={color} strokeWidth="2.4" strokeLinecap="round" />
      </svg>
    );
  if (tone === "uploaded")
    return (
      <svg width={size} height={size} viewBox="0 0 44 44" fill="none" aria-hidden="true" focusable="false">
        <circle cx="22" cy="22" r="21" fill={track} />
        <path d="M18 16v12l10-6-10-6z" stroke={color} strokeWidth="2.2" strokeLinejoin="round" />
      </svg>
    );
  return (
    <svg width={size} height={size} viewBox="0 0 44 44" fill="none" aria-hidden="true" focusable="false">
      <circle cx="22" cy="22" r="21" fill={track} />
      <path d="M22 13v10l6 4" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function ResumePage() {
  const queryClient = useQueryClient();
  const fileRef = useRef(null);
  const toastTimer = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const [toast, setToast] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const showToast = (message) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  };

  const resumesQuery = useQuery({
    queryKey: ["resumes"],
    queryFn: () => listResumes(),
    refetchInterval: (query) => (
      (query.state.data?.items ?? []).some((r) => POLLED_RESUME_STATUSES.has(String(r.status).toLowerCase())) ? 3000 : false
    ),
  });

  const uploadMutation = useMutation({
    mutationFn: uploadResume,
    onSuccess: (resume) => {
      queryClient.invalidateQueries({ queryKey: ["resumes"] });
      showToast(`"${resume?.filename || "Resume"}" uploaded. Processing started.`);
    },
    onError: () => showToast("Upload failed. Please try again."),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteResume,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["resumes"] });
      setDeletingId(null);
      showToast("Resume deleted.");
    },
    onError: () => {
      setDeletingId(null);
      showToast("Could not delete this resume. Please try again.");
    },
  });

  const resumes = resumesQuery.data?.items ?? [];
  const latest = resumes.length
    ? resumes.reduce((a, b) => (new Date(b.created_at) > new Date(a.created_at) ? b : a))
    : null;
  const detail = statusDetail(latest);
  const hasResumes = resumes.length > 0;
  const uploading = uploadMutation.isPending;

  const startUpload = (file) => {
    if (!file || uploading) return;
    const problem = validateFile(file);
    if (problem) {
      showToast(problem);
      return;
    }
    uploadMutation.mutate(file);
  };

  const handleFileChange = (event) => {
    const file = event.target.files?.[0];
    startUpload(file);
    event.target.value = "";
  };

  const openFilePicker = () => fileRef.current?.click();

  return (
    <div className="app-page resume-page">
      <TopBar />
      <div className="page-container resume-container">
        <div className="resume-page-heading">
          <div>
            <span className="dashboard-eyebrow">RESUME WORKSPACE</span>
            <h1>Your resume</h1>
            <p>Upload and manage the resume used to personalise your interview questions.</p>
          </div>
          <button
            type="button"
            className="resume-heading-action"
            onClick={() => resumesQuery.refetch()}
            disabled={resumesQuery.isFetching}
          >
            {resumesQuery.isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        <div className="resume-workspace-grid">
          <section className="resume-upload-card">
            <div
              className={`resume-dropzone${isDragging ? " is-dragging" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                if (!uploading) setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setIsDragging(false);
                startUpload(event.dataTransfer.files?.[0]);
              }}
            >
              <span className="resume-cloud-icon" aria-hidden="true"><CloudIcon /></span>
              <h2 id="resume-upload-title">Upload your resume</h2>
              <p>Drag &amp; drop your file here, or browse. PDF, DOC or DOCX up to 10&nbsp;MB.</p>
              <button type="button" className="main-button" onClick={openFilePicker} disabled={uploading}>
                {uploading ? "Uploading…" : "Upload resume"}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.doc,.docx"
                onChange={handleFileChange}
                aria-label="Resume file"
                style={{ display: "none" }}
              />
              {uploadMutation.error ? (
                <ErrorBox error={uploadMutation.error} onRetry={() => uploadMutation.reset()} />
              ) : null}
            </div>
          </section>

          <aside className="resume-status-card">
            <StatusIcon tone={detail.tone} />
            <h2 id="resume-status-title">{detail.title}</h2>
            <p>{detail.description}</p>
            {latest && detail.tone === "processing" ? (
              <button
                type="button"
                className="resume-heading-action"
                onClick={() => resumesQuery.refetch()}
                disabled={resumesQuery.isFetching}
              >
                Check status again
              </button>
            ) : null}
          </aside>
        </div>

        {hasResumes ? (
          <div className="resume-table-panel">
            <div className="resume-section-heading">
              <div>
                <span className="dashboard-eyebrow">YOUR DOCUMENTS</span>
                <h2>Your Resumes</h2>
              </div>
              <span className="resume-count">
                {resumesQuery.data?.total ?? 0} document{(resumesQuery.data?.total ?? 0) === 1 ? "" : "s"}
              </span>
            </div>

            {resumesQuery.isPending ? <StatusLine>Loading resumes...</StatusLine> : null}
            <ErrorBox error={resumesQuery.error} onRetry={() => resumesQuery.refetch()} />

            <div className="resume-table" role="table" aria-label="Your resumes">
              <div className="resume-table-row resume-table-head" role="row">
                {RESUME_TABLE_HEAD.map((heading) => <span key={heading}>{heading}</span>)}
              </div>
              {resumes.map((resume) => (
                <div className="resume-table-row" role="row" key={resume.id}>
                  <span>
                    <strong>
                      <span className="resume-file-icon" aria-hidden="true"><ResumeFileIcon /></span>
                      {resume.filename}
                    </strong>
                  </span>
                  <span>{formatDateTime(resume.created_at)}</span>
                  <span>
                    <em className={`resume-chip resume-chip-${statusDetail(resume).tone}`}>
                      {statusDetail(resume).label}
                    </em>
                  </span>
                  <div className="resume-actions">
                    <button
                      type="button"
                      className="resume-delete"
                      disabled={deleteMutation.isPending}
                      onClick={() => {
                        if (window.confirm(`Delete "${resume.filename}"? This cannot be undone.`)) {
                          setDeletingId(resume.id);
                          deleteMutation.mutate(resume.id);
                        }
                      }}
                      aria-label={`Delete ${resume.filename}`}
                    >
                      {deletingId === resume.id ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="resume-empty-panel">
            <EmptyState title="No resumes yet">
              <p>Upload your first resume to unlock personalised interview questions tailored to your background.</p>
              <button type="button" className="main-button" style={{ minWidth: "160px" }} onClick={openFilePicker}>
                Upload your first resume
              </button>
            </EmptyState>
          </div>
        )}

        {toast ? (
          <div className="upload-toast" role="status" aria-live="polite">{toast}</div>
        ) : null}
      </div>
    </div>
  );
}

