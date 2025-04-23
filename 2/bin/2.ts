import { App } from 'aws-cdk-lib';
import { Ec2LoggingStack } from '../lib/ec2_logging_stack';

const app = new App();
new Ec2LoggingStack(app, 'Ec2LoggingStack', {
  env: { region: 'ap-northeast-1' },
});
