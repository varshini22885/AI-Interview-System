import { useState } from "react";
import { Link } from "react-router-dom";
import { TopBar } from "../App.jsx";

const FAQ_SECTIONS = [
  {
    heading: "Getting started",
    items: [
      {
        q: "How do I start an interview?",
        a: "Upload a resume on the Resume page, then open Interview Setup. Work through the five steps — resume, role, interview type, settings, review — and choose Create. You land in the lobby while the server prepares your questions, then you can begin.",
      },
      {
        q: "Where can I see previous interviews?",
        a: "Open the History page from the sidebar. Every interview you created is listed there with its role, type, status and score, and each finished interview links to its full report.",
      },
      {
        q: "What is Insights used for?",
        a: "Insights turns your finished interviews into analytics: average and best scores, score trends over time, strengths and weaknesses pulled from your reports, and preparation metrics such as completed interviews and questions practised.",
      },
    ],
  },
  {
    heading: "Resume & roles",
    items: [
      {
        q: "How does resume upload work?",
        a: "On the Resume page, choose a PDF or DOCX file (up to 10 MB). The backend extracts the text and parses your skills and experience. The status moves from Processing to Ready, and you can then select that resume during interview setup.",
      },
      {
        q: "Can I choose a custom role?",
        a: "Yes. In step 2 of Interview Setup, use Search roles to filter the list, or pick Custom Role and type any job title you want. The exact value is sent to the backend and used for question generation.",
      },
      {
        q: "Can I choose a custom programming language?",
        a: "Yes. In step 4 (Settings) you can pick a suggested language or type your own into the custom language field. The value you type is sent through to the interview exactly as entered.",
      },
      {
        q: "How are interview questions generated?",
        a: "When you create an interview, the backend combines your resume, target role, interview type and settings, then an AI service generates role-relevant questions. Preparation usually takes under a minute; the lobby shows live progress.",
      },
    ],
  },
  {
    heading: "Scores & reports",
    items: [
      {
        q: "How are answers evaluated?",
        a: "After you submit an answer, the AI evaluator scores it for technical accuracy, communication clarity and relevance to the role, and returns written feedback with strengths and improvements. Scores are persisted with the interview.",
      },
      {
        q: "What do interview scores mean?",
        a: "Scores run from 0 to 100. Higher is better: roughly 80+ is strong, 60-79 is solid with room to grow, and below 60 highlights areas to practise. Each report breaks the score into technical, communication and problem-solving parts.",
      },
    ],
  },
  {
    heading: "If something goes wrong",
    items: [
      {
        q: "What happens if interview preparation fails?",
        a: "The lobby shows a Preparation Failed state with the server's explanation. Nothing is faked: the interview stays in a failed state in the backend, and no questions are generated.",
      },
      {
        q: "How do I retry a failed interview?",
        a: "From the lobby, use Retry to ask the server to prepare that interview again, or Back to Setup to adjust your role, language or settings and create a fresh interview. Check your resume is Ready first.",
      },
    ],
  },
  {
    heading: "Your account",
    items: [
      {
        q: "How do I update my profile?",
        a: "Open the account menu from the header avatar or the sidebar profile. Your name and email are shown exactly as stored. Education details and avatar uploads are not collected yet, so there is nothing to edit for now.",
      },
    ],
  },
];

function FaqItem({ question, answer, open, onToggle, panelId, buttonId }) {
  return (
    <div className={`faq-item${open ? " is-open" : ""}`}>
      <button
        className="faq-question"
        type="button"
        id={buttonId}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <span>{question}</span>
        <span className="faq-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="faq-answer" id={panelId} role="region" aria-labelledby={buttonId}>
          <p>{answer}</p>
        </div>
      ) : null}
    </div>
  );
}

export default function HelpPage() {
  const [openKey, setOpenKey] = useState("0-0");

  return (
    <div className="app-page help-page">
      <TopBar title="Help & FAQ" />
      <div className="page-container">
        <div className="page-title">
          <span>HELP CENTER</span>
          <h1>Help &amp; FAQ</h1>
          <p>Student-friendly answers about interviews, resumes, scores and your account. No account changes are made here.</p>
        </div>

        <div className="help-grid">
          {FAQ_SECTIONS.map((section, sectionIndex) => (
            <section className="help-section" key={section.heading} aria-label={section.heading}>
              <h2>{section.heading}</h2>
              <div className="faq-list">
                {section.items.map((item, itemIndex) => {
                  const key = `${sectionIndex}-${itemIndex}`;
                  return (
                    <FaqItem
                      key={key}
                      question={item.q}
                      answer={item.a}
                      open={openKey === key}
                      onToggle={() => setOpenKey((current) => (current === key ? "" : key))}
                      panelId={`faq-panel-${sectionIndex}-${itemIndex}`}
                      buttonId={`faq-button-${sectionIndex}-${itemIndex}`}
                    />
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <div className="help-cta">
          <div>
            <strong>Ready to practise?</strong>
            <p>Start a new interview or review how you did last time.</p>
          </div>
          <div className="help-cta-actions">
            <Link className="main-button" to="/setup">Start an interview</Link>
            <Link className="ghost-button" to="/history">View history</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
