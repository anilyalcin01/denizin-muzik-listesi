// Auto-responder for terminal prompts
class AutoResponder {
  constructor(policy = 'auto') {
    this.policy = policy; // 'auto', 'ask', 'manual'
    this.rules = {
      // Package management
      'Do you want to continue? [Y/n]': 'Y',
      'Proceed with installation? (y/n)': 'y',
      'Continue? [Y/n]': 'Y',
      
      // npm
      'Is this OK? (yes)': 'yes',
      'Overwrite': 'y',
      
      // git
      'Are you sure you want to continue connecting': 'yes',
      
      // System updates
      'Do you want to continue? [Y/n]': 'Y',
      'Restart services': 'Y',
      
      // File operations
      'Overwrite existing file?': 'y',
      'Remove': 'y',
      
      // Custom rules
      'pm2 restart': 'auto',
      'systemctl restart': 'auto'
    };
    
    this.dangerousPatterns = [
      /rm\s+-rf\s+\/(?!tmp|var\/tmp)/i,
      /drop\s+database/i,
      /truncate\s+table/i,
      /delete\s+from.*where\s+1=1/i,
      /chmod\s+777/i,
      /production.*delete/i
    ];
  }

  shouldAutoRespond(prompt, command) {
    if (this.isDangerous(command)) {
      return { auto: false, reason: 'DANGEROUS_COMMAND' };
    }

    if (this.policy === 'manual') {
      return { auto: false, reason: 'MANUAL_MODE' };
    }

    for (let pattern in this.rules) {
      if (prompt.includes(pattern)) {
        return { 
          auto: true, 
          response: this.rules[pattern],
          matched: pattern
        };
      }
    }

    return { auto: false, reason: 'NO_RULE_MATCH' };
  }

  isDangerous(command) {
    return this.dangerousPatterns.some(pattern => pattern.test(command));
  }

  addRule(pattern, response) {
    this.rules[pattern] = response;
  }
}

module.exports = AutoResponder;
