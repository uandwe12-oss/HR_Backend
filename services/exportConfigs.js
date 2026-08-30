// services/exportConfigs.js

const EXPORT_CONFIGS = [
  {
    moduleName: 'Candidates',
    query: 'MATCH (c:Candidate_Profile) RETURN c ORDER BY c.createdAt DESC',
    fileName: 'candidates_backup.xlsx',
    historyFile: 'candidates_export_history.json',
    nodeKey: 'c',
    priorityKeys: ['Can_ID', 'id', 'email', 'name', 'phone', 'status', 'googleDriveViewLink'],
    cronSchedule: '0 0 * * *' // 12:00 AM
  },
  
  {
    moduleName: 'Demand',
    query: 'MATCH (d:Demand) OPTIONAL MATCH (d)-[:HAS_SELECTED_CANDIDATE]->(c:Candidate_Profile) RETURN d, count(c) AS selectedCount ORDER BY d.createdDate DESC',
    fileName: 'demand_backup.xlsx',
    historyFile: 'demand_export_history.json',
    nodeKey: 'd',
    priorityKeys: ['id', 'title', 'status', 'clientName', 'selectedCount'],
    cronSchedule: '5 0 * * *' // 12:05 AM
  },
  {
    moduleName: 'Timesheet',
    query: 'MATCH (t:TimesheetRecord) RETURN t ORDER BY t.createdAt DESC',
    fileName: 'timesheets_backup.xlsx',
    historyFile: 'timesheet_export_history.json',
    nodeKey: 't',
    priorityKeys: ['id', 'userId', 'monthStr', 'status', 'totalWorkingHours'],
    cronSchedule: '10 0 * * *' // 12:10 AM
  },
  {
    moduleName: 'SalaryAdvance',
    query: 'MATCH (s:SalaryAdvanceRequest) RETURN s ORDER BY s.createdAt DESC',
    fileName: 'salaryadvance_backup.xlsx',
    historyFile: 'salaryadvance_export_history.json',
    nodeKey: 's',
    priorityKeys: ['id', 'userId', 'amount', 'status'],
    cronSchedule: '15 0 * * *' // 12:15 AM
  },
  {
    moduleName: 'Reimbursement',
    query: 'MATCH (r:Reimbursement) RETURN r ORDER BY r.createdAt DESC',
    fileName: 'reimbursement_backup.xlsx',
    historyFile: 'reimbursement_export_history.json',
    nodeKey: 'r',
    priorityKeys: ['id', 'userId', 'amount', 'status'],
    cronSchedule: '20 0 * * *' // 12:20 AM
  },
  {
    moduleName: 'Asset',
    query: 'MATCH (a:EmployeeAsset) RETURN a',
    fileName: 'employeeasset_backup.xlsx',
    historyFile: 'asset_export_history.json',
    nodeKey: 'a',
    priorityKeys: ['id', 'name', 'status', 'assignedTo'],
    cronSchedule: '25 0 * * *' // 12:25 AM
  },
  {
    moduleName: 'Leave',
    query: 'MATCH (l:LeaveRequest) RETURN l ORDER BY l.createdAt DESC',
    fileName: 'leaverequest_backup.xlsx',
    historyFile: 'leave_export_history.json',
    nodeKey: 'l',
    priorityKeys: ['id', 'userId', 'leaveType', 'status'],
    cronSchedule: '30 0 * * *' // 12:30 AM
  },
  {
    moduleName: 'News',
    query: 'MATCH (n:News) RETURN n ORDER BY n.createdAt DESC',
    fileName: 'news_backup.xlsx',
    historyFile: 'news_export_history.json',
    nodeKey: 'n',
    priorityKeys: ['id', 'title', 'date'],
    cronSchedule: '35 0 * * *' // 12:35 AM
  },
  {
    moduleName: 'Payroll',
    query: 'MATCH (p:PayrollRecord) RETURN p ORDER BY p.createdAt DESC',
    fileName: 'payroll_backup.xlsx',
    historyFile: 'payroll_export_history.json',
    nodeKey: 'p',
    priorityKeys: ['id', 'userId', 'month', 'year', 'netSalary'],
    cronSchedule: '40 0 * * *' // 12:40 AM
  },
  {
    moduleName: 'Policy',
    query: 'MATCH (p:Policy) RETURN p',
    fileName: 'policy_backup.xlsx',
    historyFile: 'policy_export_history.json',
    nodeKey: 'p',
    priorityKeys: ['id', 'title'],
    cronSchedule: '45 0 * * *' // 12:45 AM
  },
  {
    moduleName: 'Insurance',
    query: 'MATCH (i:InsurancePolicy) RETURN i',
    fileName: 'insurance_backup.xlsx',
    historyFile: 'insurance_export_history.json',
    nodeKey: 'i',
    priorityKeys: ['id', 'policyNumber', 'provider'],
    cronSchedule: '50 0 * * *' // 12:50 AM
  },
  {
    moduleName: 'PersonalDetails',
    query: 'MATCH (p:PersonalDetails) RETURN p',
    fileName: 'personaldetails_backup.xlsx',
    historyFile: 'personaldetails_export_history.json',
    nodeKey: 'p',
    priorityKeys: ['id', 'userId', 'nationality'],
    cronSchedule: '55 0 * * *' // 12:55 AM
  },
  {
    moduleName: 'Holiday',
    query: 'MATCH (h:Holiday) RETURN h ORDER BY h.date DESC',
    fileName: 'holiday_backup.xlsx',
    historyFile: 'holiday_export_history.json',
    nodeKey: 'h',
    priorityKeys: ['id', 'name', 'date', 'type'],
    cronSchedule: '0 1 * * *' // 1:00 AM
  },
  {
    moduleName: 'Birthday',
    query: 'MATCH (b:BirthdayWishLog) RETURN b',
    fileName: 'birthdaywishlog_backup.xlsx',
    historyFile: 'birthdaywishlog_export_history.json',
    nodeKey: 'b',
    priorityKeys: ['id', 'name', 'date'],
    cronSchedule: '0 2 * * *' // 2:00 AM
  },
  {
    moduleName: 'Allocation',
    query: 'MATCH (a:Allocation) RETURN a',
    fileName: 'allocation_backup.xlsx',
    historyFile: 'allocation_export_history.json',
    nodeKey: 'a',
    priorityKeys: ['id', 'userId', 'team'],
    cronSchedule: '5 1 * * *' // 1:05 AM
  },
  {
    moduleName: 'Group',
    query: 'MATCH (g:Group) RETURN g',
    fileName: 'group_backup.xlsx',
    historyFile: 'group_export_history.json',
    nodeKey: 'g',
    priorityKeys: ['id', 'name'],
    cronSchedule: '10 1 * * *' // 1:10 AM
  },
  {
    moduleName: 'LeaveBalance',
    query: 'MATCH (l:LeaveBalance) RETURN l',
    fileName: 'leavebalance_backup.xlsx',
    historyFile: 'leavebalance_export_history.json',
    nodeKey: 'l',
    priorityKeys: ['id', 'userId'],
    cronSchedule: '15 1 * * *' // 1:15 AM
  },
  {
    moduleName: 'Skill',
    query: 'MATCH (s:Skill) RETURN s',
    fileName: 'skill_backup.xlsx',
    historyFile: 'skill_export_history.json',
    nodeKey: 's',
    priorityKeys: ['id', 'name'],
    cronSchedule: '20 1 * * *' // 1:20 AM
  },
  {
    moduleName: 'User',
    query: 'MATCH (u:User) RETURN u',
    fileName: 'user_backup.xlsx',
    historyFile: 'user_export_history.json',
    nodeKey: 'u',
    priorityKeys: ['id', 'username', 'role'],
    cronSchedule: '25 1 * * *' // 1:25 AM
  },
  {
    moduleName: 'Zone',
    query: 'MATCH (z:Zone) RETURN z',
    fileName: 'zone_backup.xlsx',
    historyFile: 'zone_export_history.json',
    nodeKey: 'z',
    priorityKeys: ['id', 'name'],
    cronSchedule: '30 1 * * *' // 1:30 AM
  },
  {
    moduleName: 'CountryFieldConfig',
    query: 'MATCH (c:CountryFieldConfig) RETURN c',
    fileName: 'countryfieldconfig_backup.xlsx',
    historyFile: 'countryfieldconfig_export_history.json',
    nodeKey: 'c',
    priorityKeys: ['id', 'country'],
    cronSchedule: '35 1 * * *' // 1:35 AM
  }
];

module.exports = EXPORT_CONFIGS;
