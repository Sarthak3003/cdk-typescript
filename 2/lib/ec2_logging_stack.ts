// CDK Application in TypeScript for EC2 Logging Pipeline
import { App, Stack, StackProps, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Instance, InstanceType, MachineImage, Vpc, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { Role, ServicePrincipal, ManagedPolicy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays, SubscriptionFilter, FilterPattern } from 'aws-cdk-lib/aws-logs';
import { UserData } from 'aws-cdk-lib/aws-ec2';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Function, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { LambdaDestination } from 'aws-cdk-lib/aws-logs-destinations';
import { SecurityGroup, Peer, Port } from 'aws-cdk-lib/aws-ec2';
import * as path from 'path';

export class Ec2LoggingStack extends Stack {
  constructor(scope: App, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, 'AppVPC', {
      maxAzs: 2,
      subnetConfiguration: [{ name: 'public', subnetType: SubnetType.PUBLIC }]
    });

    const ec2Role = new Role(this, 'EC2Role', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
    });

    ec2Role.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'));
    ec2Role.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'));

    const logGroup = new LogGroup(this, 'AppLogGroup', {
      logGroupName: '/ec2/app/logs',
      retention: RetentionDays.ONE_WEEK
    });

    const securityGroup = new SecurityGroup(this, 'WebSG', {
      vpc,
      allowAllOutbound: true,
    });
    
    securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(80), 'Allow HTTP traffic');
    securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(22), 'Allow SSH');
    securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(443), 'Allow HTTPS traffic');

    const userData = UserData.forLinux();
    userData.addCommands(
      'yum update -y',
      'yum install -y httpd amazon-cloudwatch-agent',
      'systemctl start httpd',
      'systemctl enable httpd',
      'echo "<html><head><title>Hello</title></head><body><h1>Hello World</h1></body></html>" > /var/www/html/index.html',
    
      // Write CloudWatch Agent config
      'cat <<EOF > /opt/aws/amazon-cloudwatch-agent/bin/config.json',
      '{',
      '  "logs": {',
      '    "logs_collected": {',
      '      "files": {',
      '        "collect_list": [',
      '          {',
      '            "file_path": "/var/log/httpd/access_log",',
      '            "log_group_name": "/ec2/app/logs",',
      '            "log_stream_name": "{instance_id}/access_log",',
      '            "timestamp_format": "%d/%b/%Y:%H:%M:%S %z"',
      '          },',
      '          {',
      '            "file_path": "/var/log/httpd/error_log",',
      '            "log_group_name": "/ec2/app/logs",',
      '            "log_stream_name": "{instance_id}/error_log",',
      '            "timestamp_format": "%Y/%m/%d %H:%M:%S"',
      '          }',
      '        ]',
      '      }',
      '    }',
      '  }',
      '}',
      'EOF',
    
      // Start CloudWatch agent with the config
      '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/bin/config.json -s'
    );

    const instance = new Instance(this, 'AppInstance', {
      vpc,
      instanceType: new InstanceType('t3.micro'),
      machineImage: MachineImage.latestAmazonLinux2(),
      role: ec2Role,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      associatePublicIpAddress: true,
      userData: userData,
      securityGroup: securityGroup,
    });

    const bucket = new Bucket(this, 'LogStorageBucket', {
      versioned: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{
        expiration: Duration.days(30),
        noncurrentVersionExpiration: Duration.days(30),
      }],
    }
    );

    const lambdaRole = new Role(this, 'LambdaRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    lambdaRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'));
    lambdaRole.addToPolicy(new PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [`${bucket.bucketArn}/*`],
    }));

    const logProcessor = new Function(this, 'LogProcessor', {
      runtime: Runtime.PYTHON_3_9,
      handler: 'index.handler',
      code: Code.fromAsset(path.join(__dirname, '..', 'lambda')), // Assume Python file is in /lambda
      timeout: Duration.seconds(30),
      role: lambdaRole,
      environment: {
        BUCKET_NAME: bucket.bucketName,
      },
    });

    bucket.grantWrite(logProcessor);

    new SubscriptionFilter(this, 'LogFilter', {
      logGroup,
      destination: new LambdaDestination(logProcessor),
      filterPattern: FilterPattern.allEvents(),
    });

    logGroup.applyRemovalPolicy(RemovalPolicy.DESTROY);
  }
}

const app = new App();
new Ec2LoggingStack(app, 'Ec2LoggingStack', {
  env: { region: 'ap-northeast-1' }, // Tokyo Region
});
