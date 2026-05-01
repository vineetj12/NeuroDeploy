import { useEffect, useState } from "react";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid } from "recharts";
import { getAnalyticsSummary, getAnalyticsTimeline, getAnalyticsFiles } from "../api/client";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import "./AnalyticsPage.css";

const COLORS = ["#6366f1", "#8b5cf6", "#ec4899", "#14b8a6", "#f59e0b", "#ef4444", "#3b82f6"];

export default function AnalyticsPage() {
  const [summary, setSummary] = useState<any>(null);
  const [timeline, setTimeline] = useState<any[]>([]);
  const [files, setFiles] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchAll() {
      try {
        const [sumRes, timeRes, fileRes] = await Promise.all([
          getAnalyticsSummary(),
          getAnalyticsTimeline(30),
          getAnalyticsFiles(10),
        ]);
        setSummary(sumRes);
        setTimeline(timeRes);
        setFiles(fileRes);
      } catch (err: any) {
        setError(err.message || "Failed to load analytics");
      } finally {
        setIsLoading(false);
      }
    }
    fetchAll();
  }, []);

  if (isLoading) {
    return <div className="analytics-page loading">Loading insights...</div>;
  }

  if (error) {
    return (
      <div className="analytics-page">
        <Badge variant="error">{error}</Badge>
      </div>
    );
  }

  if (!summary || summary.totalJobs === 0) {
    return (
      <div className="analytics-page empty">
        <Card>
          <h3>No Data Yet</h3>
          <p>Once NeuroDeploy runs automated fixes, your analytics will appear here.</p>
        </Card>
      </div>
    );
  }

  const topError = summary.topErrors[0]?.category || "None";

  // Reformat dates for timeline
  const formattedTimeline = timeline.map(t => ({
    ...t,
    displayDate: new Date(t.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  }));

  // Custom tooltip for timeline
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="analytics-tooltip">
          <p className="label">{label}</p>
          <p className="intro">Success Rate: {payload[0].value}%</p>
          <p className="desc">Total Jobs: {payload[0].payload.total}</p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="analytics-page">
      <div className="dashboard-header">
        <h1>Fix Analytics</h1>
        <p className="subtitle">Insights into your automated remediation workflows</p>
      </div>

      <div className="stats-grid">
        <Card>
          <div className="stat-label">Total Fixes</div>
          <div className="stat-value">{summary.totalJobs}</div>
        </Card>
        <Card>
          <div className="stat-label">Success Rate</div>
          <div className="stat-value text-success">{summary.successRate}%</div>
        </Card>
        <Card>
          <div className="stat-label">Avg. Fix Time</div>
          <div className="stat-value">{(summary.avgFixTimeMs / 1000).toFixed(1)}s</div>
        </Card>
        <Card>
          <div className="stat-label">Top Error</div>
          <div className="stat-value error-cat">{topError.replace(/_/g, " ")}</div>
        </Card>
      </div>

      <div className="charts-grid">
        {/* SUCCESS RATE TIMELINE */}
        <Card className="chart-card span-2">
          <h3>Success Rate (Last 30 Days)</h3>
          <div className="chart-wrapper">
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={formattedTimeline}>
                <defs>
                  <linearGradient id="colorSuccess" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.8} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#ffffff1a" />
                <XAxis dataKey="displayDate" stroke="#888" tick={{ fill: "#888", fontSize: 12 }} />
                <YAxis domain={[0, 100]} unit="%" stroke="#888" tick={{ fill: "#888", fontSize: 12 }} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="successRate" stroke="#6366f1" strokeWidth={3} fillOpacity={1} fill="url(#colorSuccess)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* MOST COMMON ERRORS */}
        <Card className="chart-card">
          <h3>Error Categories</h3>
          <div className="chart-wrapper">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={summary.topErrors} layout="vertical" margin={{ top: 0, right: 30, left: 20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#ffffff1a" />
                <XAxis type="number" stroke="#888" tick={{ fill: "#888", fontSize: 12 }} />
                <YAxis dataKey="category" type="category" width={100} stroke="#888" tick={{ fill: "#888", fontSize: 10 }} />
                <Tooltip
                  cursor={{ fill: "#ffffff0a" }}
                  contentStyle={{ backgroundColor: "#1e1e1e", border: "1px solid #333", borderRadius: "8px" }}
                />
                <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                  {summary.topErrors.map((_: any, index: number) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* PROVIDER STATS */}
        <Card className="chart-card">
          <h3>AI Provider Performance (Avg Time)</h3>
          <div className="chart-wrapper">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={summary.providerStats}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#ffffff1a" />
                <XAxis dataKey="provider" stroke="#888" tick={{ fill: "#888", fontSize: 12 }} />
                <YAxis stroke="#888" tick={{ fill: "#888", fontSize: 12 }} unit="ms" />
                <Tooltip
                  cursor={{ fill: "#ffffff0a" }}
                  contentStyle={{ backgroundColor: "#1e1e1e", border: "1px solid #333", borderRadius: "8px" }}
                />
                <Bar dataKey="avgDurationMs" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* MOST FIXED FILES */}
        <Card className="chart-card span-2 files-card">
          <h3>Most Frequently Fixed Files</h3>
          {files.length === 0 ? (
            <p className="no-data">No files fixed yet.</p>
          ) : (
            <div className="files-list">
              {files.map((f, i) => {
                const maxCount = Math.max(...files.map(x => x.count));
                const percentage = Math.round((f.count / maxCount) * 100);
                return (
                  <div key={i} className="file-row">
                    <span className="file-name">{f.file}</span>
                    <div className="file-bar-bg">
                      <div className="file-bar-fill" style={{ width: `${percentage}%` }} />
                    </div>
                    <span className="file-count">{f.count}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
