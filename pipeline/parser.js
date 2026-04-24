// Parse markdown/JSON work plans into executable tasks
class PlanParser {
  static parseMarkdown(markdown) {
    const tasks = [];
    const lines = markdown.split('\n');
    let currentContext = null;

    for (let line of lines) {
      if (line.startsWith('##')) {
        currentContext = line.replace(/^##\s*/, '').trim();
        continue;
      }

      const checkboxMatch = line.match(/^[\s-]*\[[ x]\]\s*(.+)$/i);
      if (checkboxMatch) {
        const description = checkboxMatch[1].trim();
        const command = this.extractCommand(description);
        tasks.push({
          type: 'task',
          description,
          context: currentContext,
          executor: command ? 'terminal' : this.inferExecutor(description),
          command: command
        });
      }
    }

    return tasks;
  }

  static parseJSON(json) {
    const plan = typeof json === 'string' ? JSON.parse(json) : json;
    return plan.tasks || plan.steps || [];
  }

  static inferExecutor(description) {
    const lower = description.toLowerCase();
    
    if (lower.includes('claude') || lower.includes('ai') || lower.includes('generate') || lower.includes('sor:')) {
      return 'claude';
    }
    
    if (lower.includes('install') || lower.includes('npm') || lower.includes('git') || 
        lower.includes('restart') || lower.includes('deploy')) {
      return 'terminal';
    }

    if (lower.includes('test') || lower.includes('check')) {
      return 'terminal';
    }

    return 'claude';
  }

  static extractCommand(description) {
    const match = description.match(/`([^`]+)`/);
    if (match) return match[1];

    if (description.includes('restart nginx')) return 'systemctl restart nginx';
    if (description.includes('restart pm2')) return 'pm2 restart all';
    if (description.includes('git pull')) return 'git pull origin main';

    return null;
  }
}

module.exports = PlanParser;
